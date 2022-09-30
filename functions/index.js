const functions = require("firebase-functions");
const mkdirp = require("mkdirp");
const admin = require("firebase-admin");
const spawn = require("child-process-promise").spawn;
const path = require("path");
const os = require("os");
const fs = require("fs");
const sizeOf = require("image-size");

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

    const signedImageUrlArr = await response[0].getSignedUrl({
      action: "read",
      expires: "01-01-2222",
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

exports.muteChecker = functions.pubsub
  .schedule("every minute")
  .onRun(async (context) => {
    functions.logger.info("Mute checker invoked");
    try {
      const mutesRef = admin.firestore().collection(`mutes`);
      const mutes = await mutesRef.get();
      mutes.forEach(async (mute) => {
        const muteData = mute.data();
        const now = new Date();
        functions.logger.info(
          `channelId: ${muteData.channel}, userId: ${
            muteData.user
          }, expiresAt:${muteData.expiresAt}, now is ${now} is expired ? ${
            new Date(muteData.expiresAt) < now
          }`
        );

        if (new Date(muteData.expiresAt) < now) {
          functions.logger.info("Mute expired, removing entries.");
          const channelEntryDeleteResponse = await admin
            .firestore()
            .doc(`channels/${muteData.channel}/mutes/${muteData.user}`)
            .delete();
          functions.logger.info("channel delete", channelEntryDeleteResponse);
          const userEntryDeleteResponse = await admin
            .firestore()
            .doc(`users/${muteData.user}/mutes/${muteData.channel}`)
            .delete();
          functions.logger.info("user delete", userEntryDeleteResponse);
          const muteEntryDeleteResponse = await admin
            .firestore()
            .doc(`mutes/${mute.id}`)
            .delete();
          functions.logger.info("mute delete", muteEntryDeleteResponse);
        }
      });

      return true;
    } catch (ex) {
      functions.logger.error("Fn failed with:", ex);
      return false;
    }
  });

// read mutes
// get userId, channelId
// check mute timestamp if it is in the past
//delete from /channels/{channelId}/mutes/{userId}
// delete from /users/{userId}/mutes/{channelId}
