'use strict';

const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let firebaseApp = null;
let initializationError = null;

function initializeFirebase() {
  if (firebaseApp) return firebaseApp;
  if (initializationError) throw initializationError;

  try {
    const fs = require('fs');
    const path = require('path');
    const credentialsPath = path.join(
      __dirname,
      'private-config',
      'firebase-service-account.json'
    );

    const credentials = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      fs.readFileSync(credentialsPath, 'utf8')
    );

    if (
      !credentials.project_id ||
      !credentials.client_email ||
      !credentials.private_key
    ) {
      throw new Error(
        'Firebase service-account credentials are incomplete.'
      );
    }

    firebaseApp = initializeApp({
      credential: cert({
        projectId: credentials.project_id,
        clientEmail: credentials.client_email,
        privateKey: credentials.private_key.replace(/\\n/g, '\n')
      })
    });

    return firebaseApp;
  } catch (error) {
    initializationError = error;
    throw error;
  }
}

async function sendEnquiryNotifications(tokens, enquiry) {
  const uniqueTokens = [
    ...new Set(
      (Array.isArray(tokens) ? tokens : [])
        .filter(token => typeof token === 'string')
        .map(token => token.trim())
        .filter(Boolean)
    )
  ];

  if (!uniqueTokens.length) {
    return {
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
      skipped: true,
      reason: 'No registered device tokens.'
    };
  }

  initializeFirebase();

  
  const message = {
    data: {
      type: 'hotel_enquiry',
      title: 'New Standard Hotel Enquiry',
      body: String(enquiry.message || 'A guest has sent an enquiry.')
        .replace(/\s+/g, ' ')
        .slice(0, 180),
      enquiryId: String(enquiry.id),
      status: String(enquiry.status || 'new'),
      senderName: String(enquiry.senderName || '').slice(0, 160),
      senderPhone: String(enquiry.senderPhone || '').slice(0, 32),
      click_action: 'OPEN_ENQUIRIES'
    },
    webpush: {
      headers: { Urgency: 'high' }
    },
    // Keep this data-only and high priority.
    // The Android app builds the notification.
    android: {
      priority: 'high'
    },
    tokens: uniqueTokens
  };


  const response = await getMessaging(firebaseApp).sendEachForMulticast(message);
  const invalidTokens = [];

  response.responses.forEach((result, index) => {
    if (!result.success) {
      const code = result.error && result.error.code;

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        invalidTokens.push(uniqueTokens[index]);
      }

      console.error(
        '[FCM] Delivery failed for a device:',
        code || 'unknown-error'
      );
    }
  });

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    invalidTokens,
    skipped: false
  };
}


async function sendEnquiryAlarmControl(tokens, enquiryId, status = 'acknowledged') {
  const uniqueTokens = [...new Set((Array.isArray(tokens) ? tokens : []).filter(token => typeof token === 'string').map(token => token.trim()).filter(Boolean))];
  if (!uniqueTokens.length) return { successCount: 0, failureCount: 0, skipped: true };
  initializeFirebase();
  const message = {
    data: { type: 'enquiry_alarm_control', alarmAction: 'stop', enquiryId: String(enquiryId), status: String(status) },
    android: { priority: 'high' },
    tokens: uniqueTokens
  };
  const response = await getMessaging(firebaseApp).sendEachForMulticast(message);
  const invalidTokens = [];
  response.responses.forEach((result, index) => {
    if (!result.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(result.error && result.error.code)) invalidTokens.push(uniqueTokens[index]);
  });
  return { successCount: response.successCount, failureCount: response.failureCount, invalidTokens, skipped: false };
}

module.exports = {
  sendEnquiryNotifications,
  sendEnquiryAlarmControl
};
