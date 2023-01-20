const functions = require("firebase-functions");
const mkdirp = require("mkdirp");
const admin = require("firebase-admin");
const spawn = require("child-process-promise").spawn;
const path = require("path");
const os = require("os");
const fs = require("fs");
const sizeOf = require("image-size");

const googleServiceAccountKey = require("./service-account-key.json");
const { key: appleKey } = require("./apple-secret.json");
const { google } = require("googleapis");
const request = require("request-promise");

admin.initializeApp();

const runtimeOpts = {
  timeoutSeconds: 60,
  memory: "256MB",
};

// possible permission issues between firebase and google cloud
// https://stackoverflow.com/questions/69288690/firebase-admin-storage-the-caller-does-not-have-permission
// https://stackoverflow.com/a/48457377/7478712
// also, add firestore admin role to the {appname}@appspot.gserviceaccount.com user on
// console.cloud.google.com/iam-admin

// there will also be an error message saying something like error below: fix it by clicking on the link
// and enabling the service api
/**
 * Error: IAM Service Account Credentials API has not been used in project 687228326786
 * before or it is disabled.
 * Enable it by visiting https://console.developers.google.com/apis/api/iamcredentials.googleapis.com/overview?project=687228326786
 * then retry. If you enabled this API recently,
 * wait a few minutes for the action to propagate to our systems and retry.
 */

/*
    - User uploads an image through the app
    - Image ends up in /files/${user?.uid}/assets/upload/${file.name}
    - This function picks up the file, scales it down to 1080p max
    - Uploads the scaled down version to /files/${user?.uid}/assets/images/${file.name}
    - Generates a publicly available signed URL
    - Deletes the originally uploaded file
*/
exports.imgDownscale = functions
  .runWith(runtimeOpts)
  .storage.object()
  .onFinalize(async (object) => {
    const filePath = object.name || "";

    functions.logger.log("Loaded file:", filePath);

    // Exit if this is triggered on a file that is not an image.
    if (!object.contentType?.startsWith("image/")) {
      functions.logger.warn("This is not an image.");
      return null;
    }

    const baseFileName = path.basename(filePath);
    const fileDir = path.dirname(`${filePath}`);
    // Exit if this is triggered on a file that is not in the uploads subdirectory
    if (!fileDir.endsWith("/upload")) {
      functions.logger.info("skip running for scaled images");
      return null;
    }
    const date = new Date();
    const scaledFilePath = path.normalize(
      path.join(fileDir, `${date.toISOString()}_${baseFileName}`)
    );
    const tempLocalFile = path.join(os.tmpdir(), filePath);
    const tempLocalDir = path.dirname(tempLocalFile);
    const tempLocalScaledFile = path.join(os.tmpdir(), scaledFilePath);
    functions.logger.log("Destination file path:", tempLocalScaledFile);

    const bucket = admin.storage().bucket(object.bucket);
    // Create the temp directory where the storage file will be downloaded.
    await mkdirp(tempLocalDir);
    // Download file from bucket.
    await bucket.file(filePath).download({ destination: tempLocalFile });
    functions.logger.info("The file has been downloaded to", tempLocalFile);

    const imgInfo = fs.statSync(tempLocalFile);
    const imgDimensions = sizeOf(tempLocalFile);
    functions.logger.log(
      "File size MB:",
      (imgInfo.size / (1024 * 1024)).toFixed(2)
    );
    functions.logger.log(
      `Image dimensions: ${imgDimensions.width}x${imgDimensions.height}`
    );
    if (imgDimensions.width > 1080) {
      functions.logger.log("Image too large, downscaling");
      await spawn("convert", [
        tempLocalFile,
        "-resize",
        "x1080",
        tempLocalScaledFile,
      ]);
    } else {
      functions.logger.log("No downscale needed");
      fs.copyFileSync(tempLocalFile, tempLocalScaledFile);
    }
    functions.logger.log("New file created at", tempLocalScaledFile);
    const bucketFilePath = scaledFilePath.replace("upload/", "images/");
    const response = await bucket.upload(tempLocalScaledFile, {
      destination: bucketFilePath,
    });
    functions.logger.info("New file uploaded to storage:", bucketFilePath);

    const newDate = new Date();
    newDate.setFullYear(date.getFullYear() + 24);
    const signedImageUrlArr = await response[0].getSignedUrl({
      action: "read",
      expires: newDate,
    });
    const signedImageUrl = signedImageUrlArr[0];
    functions.logger.info("Generated signed url:", signedImageUrl);

    // Once the image has been converted delete the
    // local files to free up disk space.
    fs.unlinkSync(tempLocalScaledFile);
    fs.unlinkSync(tempLocalFile);

    // delete the original asset/upload file
    await bucket.file(filePath).delete();
    functions.logger.info("Deleted the asset upload.");
    await admin.firestore().doc(object.metadata.messageOrigin).update({
      resource: signedImageUrl,
    });
    functions.logger.info("Updated the firestore origin message. Finishing.");
    return { originalMetadata: { ...object.metadata }, url: signedImageUrl };
  });

const messaging = admin.messaging();

exports.notifySubscribers = functions
  .runWith(runtimeOpts)
  .https.onCall(async (data, ctx) => {
    functions.logger.info("Fn invoked with data: ", data);
    functions.logger.info("Fn invoked with ctx: ", ctx);

    try {
      const response = await messaging.sendToDevice(data.targetDevices, {
        notification: {
          title: data.messageTitle,
          body: data.messageBody,
          sound: "default"
        },
        data: {
          notification_type: data.notification_type,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
          user: data.user,
          channel: data.channel,
        },
      });
      functions.logger.info(
        "Fn successfully invoked with response: ",
        response
      );
      functions.logger.info(
        "Fn successfully invoked with response.results: ",
        response.results
      );
      return true;
    } catch (ex) {
      functions.logger.error("Fn failed with:", ex);
      return false;
    }
  });

exports.muteCheckerRoomSpecific = functions.pubsub
  .schedule("every 1 minutes")
  .onRun(async (context) => {
    functions.logger.info("ROOM SPECIFIC MUTE CHECKER invoked");
    try {
      const mutesSnapshot = await admin
        .firestore()
        .collection(`mutes`)
        .where("expiresAt", "<=", new Date())
        .get();
      functions.logger.info("query returned ", mutesSnapshot.size, " results");
      mutesSnapshot.forEach(async (mute) => {
        const { user: userId, channel: channelId, chatRoom } = mute.data();
        functions.logger.info(
          "lets find user & channel object refs",
          userId,
          channelId
        );
        const userMuteDeleteResponse = await admin
          .firestore()
          .doc(`users/${userId}/mutes/${channelId}${chatRoom}`)
          .delete();
        functions.logger.info(
          "Deleted the user mute doc:",
          userMuteDeleteResponse
        );
        const channelMuteDeleteResponse = await admin
          .firestore()
          .doc(`channels/${channelId}/mutes/${userId}${chatRoom}`)
          .delete();
        functions.logger.info(
          "Deleted the channel mute doc:",
          channelMuteDeleteResponse
        );
        const deleteMuteDocResponse = await mute.ref.delete();
        functions.logger.info("Deleted the mute doc:", deleteMuteDocResponse);
      });
      return true;
    } catch (ex) {
      functions.logger.error("Fn failed with:", ex);
      return false;
    }
  });

const authClient = new google.auth.JWT({
  email: googleServiceAccountKey.client_email,
  key: googleServiceAccountKey.private_key,
  scopes: ["https://www.googleapis.com/auth/androidpublisher"],
});

const playDeveloperApiClient = google.androidpublisher({
  version: "v3",
  auth: authClient,
});

exports.verifyGoogleSubscription = functions.https.onCall(
  async (data, context) => {
    functions.logger.info(
      "Verify Google Play subscription called with data:",
      data
    );
    const skuId = data.sku_id;
    const purchaseToken = data.purchase_token;
    const packageName = data.package_name;
    const userId = data.user_id;
    const source = data.source;

    try {
      await authClient.authorize();
      functions.logger.info("Auth client authorized");
      const subscription =
        await playDeveloperApiClient.purchases.subscriptions.get({
          packageName: packageName,
          subscriptionId: skuId,
          token: purchaseToken,
        });

      functions.logger.info("Subscription object:", subscription);

      if (subscription.status === 200) {
        functions.logger.info("Sub valid", subscription.data);
        if (
          subscription.data.userCancellationTimeMillis &&
          subscription.data.userCancellationTimeMillis < Date.now()
        ) {
          functions.logger.info(
            "User Cancellation Time expired, updating to FREE",
            subscription.data.userCancellationTimeMillis
          );
          await admin.firestore().doc(`users/${userId}`).update({
            skuId: null,
            purchaseToken: null,
            source,
            subscriptionPackage: "FREE",
          });
          return {
            status: 401,
            message: "Failed to verify subscription, Try again!",
          };
        } else if (
          subscription.data.expiryTimeMillis &&
          subscription.data.expiryTimeMillis < Date.now()
        ) {
          functions.logger.info(
            "Expiry Time expired, updating to FREE",
            subscription.data.userCancellationTimeMillis
          );
          await admin.firestore().doc(`users/${userId}`).update({
            skuId: null,
            purchaseToken: null,
            source,
            subscriptionPackage: "FREE",
          });
          return {
            status: 401,
            message: "Failed to verify subscription, Try again!",
          };
        } else {
          functions.logger.info(
            "Updating user to PREMIUM package with userid: ",
            userId
          );
          await admin.firestore().doc(`users/${userId}`).update({
            skuId,
            purchaseToken,
            source,
            subscriptionPackage: "PREMIUM",
          });
          return {
            status: 200,
            message: "Subscription verification successful!",
          };
        }
      }
    } catch (error) {
      // Logging error for debugging
      functions.logger.error("Sub invalid", error);
    }

    functions.logger.info("Updating user to FREE package with id: ", userId);
    const updateResponse = await admin
      .firestore()
      .doc(`users/${userId}`)
      .update({
        skuId: null,
        purchaseToken: null,
        source,
        subscriptionPackage: "FREE",
      });
    functions.logger.info("Update response", updateResponse);

    // This message is returned when there is no successful response from the subscription/purchase get call
    return {
      status: 401,
      message: "Failed to verify subscription, Try again!",
    };
  }
);

// first check to apple's production verifyReceipt can possibly return 21007 status which indicates
// the request was made from a sandbox subscription so we should finish that call on the sandbox environment.
// if status is 0, that means everything is good, if not, check the status code legend https://developer.apple.com/documentation/appstorereceipts/status
exports.verifyAppleSubscription = functions.https.onCall(async (data) => {
  functions.logger.info("Verify Apple subscription called with data:", data);
  const skuId = data.sku_id;
  const purchaseToken = data.purchase_token;
  const userId = data.user_id;
  const source = data.source;

  const secret = appleKey;
  const options = {
    method: "POST",
    url: "https://buy.itunes.apple.com/verifyReceipt",
    body: {
      "receipt-data": purchaseToken,
      password: secret,
      "exclude-old-transactions": true,
    },
    json: true,
  };

  functions.logger.info("Calling itunes production");
  const productionResponse = await request(options);
  functions.logger.info("Production response:", productionResponse);
  if (productionResponse.status === 21007) {
    const sandBoxOptions = {
      method: "POST",
      url: "https://sandbox.itunes.apple.com/verifyReceipt",
      headers: { "Content-Type": "application/json" },
      body: {
        "receipt-data": purchaseToken,
        password: secret,
        "exclude-old-transactions": true,
      },
      json: true,
    };

    functions.logger.info("Redirected to sandbox, calling...");
    const sandboxResponse = await request(sandBoxOptions);
    functions.logger.info(
      "Sandbox response latest receipt info:",
      sandboxResponse
    );

    if (sandboxResponse.status === 0) {
      const expiresMsString =
        sandboxResponse.latest_receipt_info?.[0]?.expires_date_ms;
      functions.logger.info(
        "Subscription status === valid, let's check expiry",
        expiresMsString
      );
      if (expiresMsString && !isNaN(Number(expiresMsString))) {
        const expiresMs = Number(expiresMsString);
        if (expiresMs > Date.now()) {
          functions.logger.info(
            "Subscription PREMIUM, expiry date:",
            new Date(expiresMs)
          );
          const updateResponse = await admin
            .firestore()
            .doc(`users/${userId}`)
            .update({
              skuId,
              purchaseToken,
              source,
              subscriptionPackage: "PREMIUM",
            });
          functions.logger.info("Update response", updateResponse);
          return {
            status: 200,
            message: "Sandbox subscription verification successful!",
          };
        } else {
          functions.logger.info(
            "Subscription FREE, expiry date:",
            new Date(expiresMs)
          );
          const updateResponse = await admin
            .firestore()
            .doc(`users/${userId}`)
            .update({
              skuId: null,
              purchaseToken: null,
              source,
              subscriptionPackage: "FREE",
            });
          functions.logger.info("Update response", updateResponse);
          return {
            status: 401,
            message: "Failed to verify subscription, expired!",
          };
        }
      } else {
        functions.logger.error(
          "Something is wrong with expires_date_ms:",
          expiresMsString
        );
        return {
          status: 401,
          message: "Failed to verify subscription, expired!",
        };
      }
    } else {
      functions.logger.info(
        "Subscription invalid (possibly malformed), updating user to FREE on SANDBOX package with userId:",
        userId
      );
      functions.logger.error("Sub status", sandboxResponse.status);
      const updateResponse = await admin
        .firestore()
        .doc(`users/${userId}`)
        .update({
          skuId: null,
          purchaseToken: null,
          source,
          subscriptionPackage: "FREE",
        });
      functions.logger.info("Update response", updateResponse);
      return {
        status: 401,
        message: "Failed to verify subscription, Try again!",
      };
    }
  } else {
    if (productionResponse.status === 0) {
      const expiresMsString =
        productionResponse.latest_receipt_info?.[0]?.expires_date_ms;
      functions.logger.info(
        "Subscription status === valid, let's check expiry",
        expiresMsString
      );
      if (expiresMsString && !isNaN(Number(expiresMsString))) {
        const expiresMs = Number(expiresMsString);
        if (expiresMs > Date.now()) {
          functions.logger.info(
            "Subscription PREMIUM, expiry date:",
            new Date(expiresMs)
          );
          const updateResponse = await admin
            .firestore()
            .doc(`users/${userId}`)
            .update({
              skuId,
              purchaseToken,
              source,
              subscriptionPackage: "PREMIUM",
            });
          functions.logger.info("Update response", updateResponse);
          return {
            status: 200,
            message: "Production subscription verification successful!",
          };
        } else {
          functions.logger.info(
            "Subscription FREE, expiry date:",
            new Date(expiresMs)
          );
          const updateResponse = await admin
            .firestore()
            .doc(`users/${userId}`)
            .update({
              skuId: null,
              purchaseToken: null,
              source,
              subscriptionPackage: "FREE",
            });
          functions.logger.info("Update response", updateResponse);
          return {
            status: 401,
            message: "Failed to verify subscription, expired!",
          };
        }
      } else {
        functions.logger.error(
          "Something is wrong with expires_date_ms:",
          expiresMsString
        );
        return {
          status: 401,
          message: "Failed to verify subscription, expired!",
        };
      }
    } else {
      functions.logger.info(
        "Subscription invalid (possibly malformed), updating user to FREE on PRODUCTION package with userId:",
        userId
      );
      functions.logger.error("Sub status", productionResponse.status);
      const updateResponse = await admin
        .firestore()
        .doc(`users/${userId}`)
        .update({
          skuId: null,
          purchaseToken: null,
          source,
          subscriptionPackage: "FREE",
        });
      functions.logger.info("Update response", updateResponse);
      return {
        status: 401,
        message: "Failed to verify subscription, Try again!",
      };
    }
  }
});
