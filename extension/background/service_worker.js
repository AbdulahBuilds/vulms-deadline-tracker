/**
 * VULMS Smart Deadline Tracker - Background Service Worker (Manifest V3)
 * Manages Google Apps Script Web App communication, CORS-compliant text/plain POSTs,
 * local storage caching, retry queues, and badge state.
 */

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('[VULMS Background] Extension installed.');
  chrome.storage.local.get(['webAppUrl', 'secretToken'], (result) => {
    if (!result.webAppUrl) {
      chrome.storage.local.set({
        webAppUrl: '',
        secretToken: '',
        lastSyncStatus: 'unconfigured',
        cachedActivities: [],
        pendingRemindersCount: 0
      });
    }
  });

  // Setup periodic sync alarm
  chrome.alarms.create('vulms_health_check', { periodInMinutes: 30 });
});

// Alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vulms_health_check') {
    processPendingSyncQueue();
  }
});

/**
 * Dispatches payload to Google Apps Script Web App
 * Uses text/plain;charset=utf-8 to bypass CORS OPTIONS preflight and follows 302 redirects.
 */
async function postToGoogleAppsScript(webAppUrl, payload) {
  if (!webAppUrl || !webAppUrl.startsWith('https://script.google.com/')) {
    throw new Error('Invalid or missing Google Apps Script Web App URL.');
  }

  const response = await fetch(webAppUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Server responded with HTTP ${response.status}: ${errorText.substring(0, 100)}`);
  }

  const responseData = await response.json();
  return responseData;
}

/**
 * Updates extension icon badge
 */
function updateBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) {
      chrome.action.setBadgeBackgroundColor({ color: color });
    }
  } catch (e) {
    console.warn('[VULMS Background] Badge update error:', e);
  }
}

/**
 * Process synchronized activities received from content script
 */
async function handleActivitiesSync(data) {
  const settings = await chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentName', 'personalEmail']);
  const webAppUrl = settings.webAppUrl;
  const secretToken = settings.secretToken || '';

  if (!webAppUrl) {
    console.warn('[VULMS Background] Web App URL not configured.');
    updateBadge('SETUP', '#f59e0b'); // amber
    await chrome.storage.local.set({
      lastSyncStatus: 'unconfigured',
      studentId: data.studentId,
      studentName: data.studentName || settings.studentName,
      cachedActivities: data.activities
    });
    return { success: false, reason: 'unconfigured' };
  }

  updateBadge('SYNC', '#3b82f6'); // blue

  const sEmail = settings.personalEmail || `${data.studentId}@vu.edu.pk`;
  const sName = settings.studentName || data.studentName || 'VU Student';

  const payload = {
    action: 'sync_activities',
    secretToken: secretToken,
    studentId: data.studentId,
    studentName: sName,
    studentEmail: sEmail,
    activities: data.activities,
    clientTimestamp: data.timestamp || new Date().toISOString()
  };

  try {
    const result = await postToGoogleAppsScript(webAppUrl, payload);
    console.log('[VULMS Background] Sync response from Apps Script:', result);

    if (result.status === 'success') {
      const pendingCount = result.pendingReminders !== undefined ? result.pendingReminders : 0;
      updateBadge(pendingCount > 0 ? String(pendingCount) : 'OK', '#10b981'); // emerald

      await chrome.storage.local.set({
        lastSyncStatus: 'success',
        lastSyncTime: new Date().toISOString(),
        studentId: data.studentId,
        cachedActivities: data.activities,
        pendingRemindersCount: pendingCount,
        lastSyncSummary: {
          inserted: result.inserted || 0,
          updated: result.updated || 0,
          skipped: result.skipped || 0,
          total: data.activities.length
        }
      });

      return { success: true, result: result };
    } else {
      throw new Error(result.message || 'Apps script reported failed status.');
    }
  } catch (err) {
    console.error('[VULMS Background] Sync failed:', err);
    updateBadge('ERR', '#ef4444'); // red

    // Save to queue for retry
    await chrome.storage.local.set({
      lastSyncStatus: 'error',
      lastSyncError: err.message,
      studentId: data.studentId,
      cachedActivities: data.activities,
      pendingSyncPayload: payload
    });

    return { success: false, error: err.message };
  }
}

/**
 * Flush pending retry queue
 */
async function processPendingSyncQueue() {
  const store = await chrome.storage.local.get(['webAppUrl', 'pendingSyncPayload']);
  if (store.webAppUrl && store.pendingSyncPayload) {
    try {
      const res = await postToGoogleAppsScript(store.webAppUrl, store.pendingSyncPayload);
      if (res.status === 'success') {
        await chrome.storage.local.remove('pendingSyncPayload');
        await chrome.storage.local.set({
          lastSyncStatus: 'success',
          lastSyncTime: new Date().toISOString()
        });
        updateBadge('OK', '#10b981');
      }
    } catch (e) {
      console.warn('[VULMS Background] Retry queue execution failed:', e.message);
    }
  }
}

// Runtime message router
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'VULMS_ACTIVITIES_EXTRACTED') {
    handleActivitiesSync(request.data).then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.action === 'TEST_CONNECTION') {
    const { webAppUrl, secretToken } = request;
    postToGoogleAppsScript(webAppUrl, {
      action: 'ping',
      secretToken: secretToken || '',
      timestamp: new Date().toISOString()
    })
      .then((data) => sendResponse({ success: true, data: data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'VULMS_STUDENT_DETECTED') {
    const { studentId, studentName, vuEmail, realEmail, defaultEmail } = request.data;
    chrome.storage.local.get(['studentName', 'personalEmail', 'vuEmail', 'webAppUrl', 'secretToken'], (store) => {
      const updates = {};
      if (studentId) updates.studentId = studentId;

      const candidateName = studentName || '';
      const isSystemTitle = candidateName.toLowerCase().includes('management') ||
                            candidateName.toLowerCase().includes('system') ||
                            candidateName.toLowerCase().includes('lms');

      if (candidateName && !isSystemTitle) {
        updates.studentName = candidateName;
      } else if (!store.studentName || store.studentName.toLowerCase().includes('management')) {
        updates.studentName = 'Muhammad Abdullah';
      }

      const officialEmail = vuEmail || realEmail;
      if (officialEmail && !officialEmail.includes('studentprofile')) {
        updates.vuEmail = officialEmail;
      } else if (!store.vuEmail) {
        updates.vuEmail = 'bc240424582mab@vu.edu.pk';
      }

      chrome.storage.local.set(updates);

      if (store.webAppUrl) {
        postToGoogleAppsScript(store.webAppUrl, {
          action: 'register_student',
          secretToken: store.secretToken || '',
          studentId: studentId || store.studentId || 'BC240424582',
          studentName: updates.studentName || store.studentName || 'Muhammad Abdullah',
          studentEmail: store.personalEmail || updates.vuEmail || store.vuEmail || `${studentId}@vu.edu.pk`,
          timestamp: new Date().toISOString()
        }).catch(() => {});
      }
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'SEND_TEST_ROW_TO_SHEET') {
    chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentId'], async (store) => {
      if (!store.webAppUrl) {
        sendResponse({ success: false, error: 'Web App URL not configured.' });
        return;
      }
      const sId = store.studentId || 'BC240424582';
      const today = new Date();
      const end = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
      const payload = {
        action: 'sync_activities',
        secretToken: store.secretToken || '',
        studentId: sId,
        activities: [
          {
            activity_key: sId + '_sample_test_activity',
            course_code: 'CS101',
            course_name: 'Introduction to Computing',
            activity_title: 'Sample Assignment 1 (System Verification Test)',
            activity_type: 'Assignment',
            start_date: today.toISOString().substring(0, 10),
            end_date: end,
            activity_url: 'https://vulms.vu.edu.pk'
          }
        ]
      };
      try {
        const res = await postToGoogleAppsScript(store.webAppUrl, payload);
        if (res && res.status === 'error') {
          sendResponse({ success: false, error: res.message });
          return;
        }
        await chrome.storage.local.set({
          cachedActivities: payload.activities,
          pendingRemindersCount: 1,
          lastSyncTime: new Date().toISOString(),
          lastSyncStatus: 'success'
        });
        updateBadge('1', '#10b981');
        sendResponse({ success: true, data: res });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });
    return true;
  }

  if (request.action === 'SEND_TEST_EMAIL') {
    const { webAppUrl, secretToken, studentName, studentEmail } = request;
    postToGoogleAppsScript(webAppUrl, {
      action: 'send_test_email',
      secretToken: secretToken || '',
      studentName: studentName || 'VU Student',
      studentEmail: studentEmail || '',
      timestamp: new Date().toISOString()
    })
      .then((data) => sendResponse({ success: true, data: data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'TRIGGER_RESYNC_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_MANUAL_SYNC' }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, message: 'Please navigate to a VULMS page first.' });
          } else {
            sendResponse({ success: true });
          }
        });
      } else {
        sendResponse({ success: false, message: 'No active tab found.' });
      }
    });
    return true;
  }
});
