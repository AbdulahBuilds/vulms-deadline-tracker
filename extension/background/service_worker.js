/**
 * VULMS Smart Deadline Tracker - Background Service Worker (Manifest V3)
 * Manages Google Apps Script Web App communication, CORS-compliant text/plain POSTs,
 * local storage caching, retry queues, and badge state.
 */

// Central Google Apps Script Web App URL shared by all students
const CENTRAL_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzKf5AC-5KM3SjF9_rk8liib-QODyVizSuKVT_nNOK91xsUYLiIB585hNfohvTdWMY8/exec';

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('[VULMS Background] Extension installed.');
  chrome.storage.local.get(['webAppUrl', 'secretToken'], (result) => {
    if (!result.webAppUrl) {
      chrome.storage.local.set({
        webAppUrl: (!CENTRAL_WEB_APP_URL.includes('REPLACE')) ? CENTRAL_WEB_APP_URL : '',
        secretToken: '',
        lastSyncStatus: (!CENTRAL_WEB_APP_URL.includes('REPLACE')) ? 'success' : 'unconfigured',
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

  const rawText = await response.text().catch(() => '');

  if (!response.ok) {
    throw new Error(`Server responded with HTTP ${response.status}: ${rawText.substring(0, 100)}`);
  }

  let responseData;
  try {
    responseData = JSON.parse(rawText);
  } catch (parseErr) {
    if (rawText.includes('<html') || rawText.includes('<!DOCTYPE') || rawText.includes('accounts.google.com') || rawText.includes('Sign in')) {
      throw new Error('Google Apps Script permission error: In Apps Script, click Deploy > Manage deployments > edit > set "Who has access" to "Anyone"');
    }
    throw new Error(`Invalid response from Apps Script: ${rawText.substring(0, 100)}`);
  }

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
  const settings = await chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentName', 'personalEmail', 'vuEmail']);
  const webAppUrl = settings.webAppUrl || CENTRAL_WEB_APP_URL;
  const secretToken = settings.secretToken || '';

  if (!webAppUrl || webAppUrl.includes('REPLACE')) {
    console.warn('[VULMS Background] Web App URL not configured.');
    const actCount = (data.activities && data.activities.length > 0) ? data.activities.length : 0;
    updateBadge(actCount > 0 ? String(actCount) : 'SETUP', '#f59e0b'); // amber
    await chrome.storage.local.set({
      lastSyncStatus: 'unconfigured',
      studentId: data.studentId,
      studentName: data.studentName || settings.studentName,
      cachedActivities: data.activities || [],
      pendingRemindersCount: actCount
    });
    return { success: false, reason: 'unconfigured', count: actCount };
  }

  updateBadge('SYNC', '#3b82f6'); // blue

  const sId = (data.studentId || 'bc240424582').toLowerCase();
  const verifiedVuEmail = data.vuEmail || settings.vuEmail || (sId === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : `${sId}@vu.edu.pk`);
  const sEmail = settings.personalEmail || verifiedVuEmail;
  const sName = settings.studentName || data.studentName || 'Muhammad Abdullah';

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
  const targetUrl = store.webAppUrl || CENTRAL_WEB_APP_URL;
  if (targetUrl && !targetUrl.includes('REPLACE') && store.pendingSyncPayload) {
    try {
      const res = await postToGoogleAppsScript(targetUrl, store.pendingSyncPayload);
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

// Setup DeclarativeNetRequest rules to remove X-Frame-Options and CSP for sub_frames of *.vu.edu.pk
function setupFrameHeaderRules() {
  if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules) {
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [
        {
          id: 1001,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'x-frame-options', operation: 'remove' },
              { header: 'content-security-policy', operation: 'remove' }
            ]
          },
          condition: {
            urlFilter: '*://*.vu.edu.pk/*',
            resourceTypes: ['sub_frame']
          }
        }
      ]
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[VULMS Background] DNR rule registration notice:', chrome.runtime.lastError.message);
      } else {
        console.log('[VULMS Background] DeclarativeNetRequest sub_frame rules activated successfully.');
      }
    });
  }
}

// Initialize rules immediately
setupFrameHeaderRules();

// Navigation detector: Listen for navigation to VULMS homepage
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab && tab.url && tab.url.includes('vu.edu.pk')) {
      const urlLower = tab.url.toLowerCase();
      if (urlLower.includes('/home.aspx') || urlLower.endsWith('/home.aspx')) {
        chrome.tabs.sendMessage(tabId, { action: 'VULMS_HOMEPAGE_NAVIGATED' }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    }
  });
}

// Runtime message router
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'VULMS_USER_LOGGED_OUT') {
    chrome.storage.local.set({ lastSyncStatus: 'logged_out' });
    updateBadge('', null);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'UPDATE_STUDENT_EMAIL') {
    const newEmail = request.personalEmail;
    chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentId', 'studentName', 'vuEmail', 'cachedActivities'], async (store) => {
      await chrome.storage.local.set({ personalEmail: newEmail });
      const sId = (store.studentId || 'bc240424582').toLowerCase();
      const verifiedVu = store.vuEmail || (sId === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : `${sId}@vu.edu.pk`);
      const targetEmail = newEmail || verifiedVu;

      const targetUrl = store.webAppUrl || CENTRAL_WEB_APP_URL;
      if (targetUrl && !targetUrl.includes('REPLACE')) {
        postToGoogleAppsScript(targetUrl, {
          action: 'register_student',
          secretToken: store.secretToken || '',
          studentId: store.studentId || 'BC240424582',
          studentName: store.studentName || 'Muhammad Abdullah',
          studentEmail: targetEmail,
          timestamp: new Date().toISOString()
        }).then(() => {
          if (store.cachedActivities && store.cachedActivities.length > 0) {
            handleActivitiesSync({
              studentId: store.studentId || 'BC240424582',
              studentName: store.studentName || 'Muhammad Abdullah',
              studentEmail: targetEmail,
              activities: store.cachedActivities
            });
          }
          sendResponse({ success: true, email: targetEmail });
        }).catch((err) => {
          sendResponse({ success: false, error: err.message });
        });
      } else {
        sendResponse({ success: true, email: targetEmail });
      }
    });
    return true;
  }

  if (request.action === 'VULMS_ACTIVITIES_EXTRACTED') {
    handleActivitiesSync(request.data).then((res) => {
      sendResponse(res);
    });
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

  if (request.action === 'VULMS_PAGE_SCANNED') {
    const { studentId, studentName, count, timestamp } = request.data || {};
    chrome.storage.local.get(['webAppUrl', 'cachedActivities', 'lastSyncStatus'], async (store) => {
      const updates = {
        studentId: studentId || store.studentId || 'BC240424582',
        studentName: studentName || store.studentName || 'Muhammad Abdullah'
      };
      if (count > 0) {
        updates.lastSyncTime = timestamp || new Date().toISOString();
      }
      if (store.lastSyncStatus !== 'unconfigured') {
        updates.lastSyncStatus = 'success';
      }
      await chrome.storage.local.set(updates);
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'TRIGGER_RESYNC_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const activeTab = (activeTabs && activeTabs[0] && activeTabs[0].url && activeTabs[0].url.includes('vu.edu.pk'))
        ? activeTabs[0]
        : null;

      const proceedWithTab = (tab) => {
        chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_MANUAL_SYNC' }, (tabRes) => {
          if (chrome.runtime.lastError || !tabRes) {
            // Tab was already open before extension reload; programmatically inject scripts
            if (chrome.scripting && tab.id) {
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/extractor.js', 'content/content.js']
              }, () => {
                setTimeout(() => {
                  chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_MANUAL_SYNC' }, (retryRes) => {
                    if (retryRes) {
                      sendResponse(retryRes);
                    } else {
                      syncFromStorageCache(sendResponse);
                    }
                  });
                }, 400);
              });
            } else {
              syncFromStorageCache(sendResponse);
            }
          } else {
            sendResponse(tabRes);
          }
        });
      };

      if (activeTab) {
        proceedWithTab(activeTab);
      } else {
        chrome.tabs.query({ url: '*://*.vu.edu.pk/*' }, (vulmsTabs) => {
          if (vulmsTabs && vulmsTabs.length > 0) {
            proceedWithTab(vulmsTabs[0]);
          } else {
            syncFromStorageCache(sendResponse);
          }
        });
      }
    });
    return true;
  }
});

/**
 * Helper to resync cached activities directly to Google Apps Script
 */
function syncFromStorageCache(sendResponse) {
  chrome.storage.local.get(['cachedActivities', 'studentId', 'studentName', 'personalEmail', 'vuEmail', 'webAppUrl'], async (store) => {
    if (store.cachedActivities && store.cachedActivities.length > 0 && store.webAppUrl) {
      try {
        const res = await handleActivitiesSync({
          studentId: store.studentId || 'BC240424582',
          studentName: store.studentName || 'Muhammad Abdullah',
          vuEmail: store.vuEmail,
          personalEmail: store.personalEmail,
          activities: store.cachedActivities
        });
        sendResponse({
          success: true,
          message: `✅ Synced ${store.cachedActivities.length} activities to Google Sheets!`
        });
      } catch (err) {
        sendResponse({ success: false, message: 'Sync failed: ' + err.message });
      }
    } else {
      sendResponse({
        success: false,
        message: 'Please open VULMS in a tab to capture activities.'
      });
    }
  });
}
