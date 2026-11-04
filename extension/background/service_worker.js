/**
 * VULMS Smart Deadline Tracker - Background Service Worker (Manifest V3)
 * Manages Google Apps Script Web App communication, CORS-compliant text/plain POSTs,
 * local storage caching, retry queues, and badge state.
 */

// Central Google Apps Script Web App URL shared by all students
const CENTRAL_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbxR7fywkiCKUKdyQtiVFbM0mS-bT3LKvaTF_geNfsgWLltSbbR2Zrbbi6zonu2c6lm4/exec';

// Ensure toolbar badge stays clean immediately upon service worker startup
try {
  chrome.action.setBadgeText({ text: '' });
} catch (e) {}

// Initialize defaults on install
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[VULMS Background] Extension installed/updated:', details ? details.reason : 'unknown');
  setupFrameHeaderRules();
  // Ensure icon stays clean without badge count
  chrome.action.setBadgeText({ text: '' });
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

  // On fresh install, automatically launch the interactive student guide in a tab
  if (details && details.reason === 'install') {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('guide/guide.html') });
    } catch (e) {
      console.warn('[VULMS Background] Could not launch guide on install:', e);
    }
  }
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
 * Updates extension icon badge (Kept completely clean without numbers/text overlay per user preference)
 */
function updateBadge(text, color) {
  try {
    // Keep toolbar icon clean - do not overlay count numbers
    chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    console.warn('[VULMS Background] Badge update error:', e);
  }
}

let activeSyncPromise = null;

/**
 * Process synchronized activities received from content script.
 * Concurrency-safe: Shares in-flight sync if multiple tabs trigger simultaneously.
 */
async function handleActivitiesSync(data) {
  if (activeSyncPromise) {
    console.log('[VULMS Background] Sync already in flight, sharing in-flight request...');
    try {
      return await activeSyncPromise;
    } catch (e) {
      // If previous failed, proceed
    }
  }

  activeSyncPromise = (async () => {
    try {
      return await executeActivitiesSync(data);
    } finally {
      activeSyncPromise = null;
    }
  })();

  return await activeSyncPromise;
}

async function executeActivitiesSync(data) {
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

  const sId = (data.studentId || '').toLowerCase();
  const verifiedVuEmail = data.vuEmail || settings.vuEmail || (sId ? `${sId}@vu.edu.pk` : 'student@vu.edu.pk');
  const sEmail = settings.personalEmail || verifiedVuEmail;
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
    let result = await postToGoogleAppsScript(webAppUrl, payload);
    console.log('[VULMS Background] Sync response from Apps Script:', result);

    // If server was temporarily busy (another sync in progress), retry once after 2 seconds
    if (result && result.status === 'busy') {
      console.log('[VULMS Background] Apps Script server busy, retrying in 2 seconds...');
      await new Promise(r => setTimeout(r, 2000));
      result = await postToGoogleAppsScript(webAppUrl, payload).catch(() => ({ status: 'busy' }));
    }

    if (result && (result.status === 'success' || result.status === 'busy')) {
      const pendingCount = (result.pendingReminders !== undefined) ? result.pendingReminders : 0;
      updateBadge(pendingCount > 0 ? String(pendingCount) : 'OK', '#10b981'); // emerald

      // Merge newly extracted activities with existing cache to maintain all courses
      const curStore = await chrome.storage.local.get(['cachedActivities']);
      const existingActs = curStore.cachedActivities || [];
      const mergedMap = new Map();
      for (const a of existingActs) {
        if (a && a.activity_key) mergedMap.set(a.activity_key, a);
      }
      for (const a of (data.activities || [])) {
        if (a && a.activity_key) mergedMap.set(a.activity_key, a);
      }
      const allCachedActivities = Array.from(mergedMap.values());

      await chrome.storage.local.set({
        lastSyncStatus: 'success',
        lastSyncTime: new Date().toISOString(),
        studentId: data.studentId,
        cachedActivities: allCachedActivities,
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
      throw new Error((result && result.message) || 'Apps script reported failed status.');
    }
  } catch (err) {
    // If it was a lock contention issue, handle gracefully without error badge
    if (err.message && (err.message.includes('Lock timeout') || err.message.includes('holding the lock'))) {
      console.warn('[VULMS Background] Apps Script lock contention handled safely:', err.message);
      return { success: true, deferred: true, message: 'Sync in progress by concurrent request' };
    }

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
    try {
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
          // Safely consume lastError
        }
      });
    } catch (e) {}
  }
}

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
    return false;
  }

  if (request.action === 'MARK_ACTIVITY_SUBMITTED') {
    const { activityKey } = request;
    chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentId', 'cachedActivities'], async (store) => {
      // 1. Update local cache
      let updatedCache = store.cachedActivities || [];
      updatedCache = updatedCache.map(a => {
        if (a.activity_key === activityKey) {
          return Object.assign({}, a, { status: 'submitted', is_submitted: true });
        }
        return a;
      });

      const todayStr = new Date().toISOString().substring(0, 10);
      const remainingPending = updatedCache.filter(a => a.status !== 'submitted' && !a.is_submitted && a.end_date >= todayStr).length;
      updateBadge(remainingPending > 0 ? String(remainingPending) : 'OK', '#10b981');

      await chrome.storage.local.set({
        cachedActivities: updatedCache,
        pendingRemindersCount: remainingPending
      });

      // 2. Dispatch to Google Apps Script backend
      const targetUrl = store.webAppUrl || CENTRAL_WEB_APP_URL;
      if (targetUrl && !targetUrl.includes('REPLACE')) {
        try {
          const res = await postToGoogleAppsScript(targetUrl, {
            action: 'mark_submitted',
            secretToken: store.secretToken || '',
            studentId: store.studentId || 'unassigned',
            activityKey: activityKey,
            timestamp: new Date().toISOString()
          });
          sendResponse({ success: true, result: res });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      } else {
        sendResponse({ success: true, cachedOnly: true });
      }
    });
    return true;
  }

  if (request.action === 'UPDATE_STUDENT_EMAIL') {
    const newEmail = request.personalEmail;
    chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentId', 'studentName', 'vuEmail', 'cachedActivities'], async (store) => {
      await chrome.storage.local.set({ personalEmail: newEmail });
      const sId = (store.studentId || '').toLowerCase();
      const verifiedVu = store.vuEmail || (sId ? `${sId}@vu.edu.pk` : 'student@vu.edu.pk');
      const targetEmail = newEmail || verifiedVu;

      const targetUrl = store.webAppUrl || CENTRAL_WEB_APP_URL;
      if (targetUrl && !targetUrl.includes('REPLACE')) {
        postToGoogleAppsScript(targetUrl, {
          action: 'register_student',
          secretToken: store.secretToken || '',
          studentId: store.studentId || 'unassigned',
          studentName: store.studentName || 'VU Student',
          studentEmail: targetEmail,
          timestamp: new Date().toISOString()
        }).then(() => {
          if (store.cachedActivities && store.cachedActivities.length > 0) {
            handleActivitiesSync({
              studentId: store.studentId || 'unassigned',
              studentName: store.studentName || 'VU Student',
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
    handleActivitiesSync(request.data)
      .then((res) => {
        try { sendResponse(res); } catch (e) {}
      })
      .catch((err) => {
        try { sendResponse({ success: false, error: (err && err.message) || String(err) }); } catch (e) {}
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
        updates.studentName = 'VU Student';
      }

      const officialEmail = vuEmail || realEmail;
      if (officialEmail && !officialEmail.includes('studentprofile')) {
        updates.vuEmail = officialEmail;
      }

      chrome.storage.local.set(updates, () => {
        try { sendResponse({ success: true }); } catch (e) {}
      });
    });
    return true;
  }

  if (request.action === 'SEND_TEST_ROW_TO_SHEET') {
    chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentId'], async (store) => {
      if (!store.webAppUrl) {
        sendResponse({ success: false, error: 'Web App URL not configured.' });
        return;
      }
      const sId = store.studentId || 'unassigned';
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

  if (request.action === 'SYNC_CALENDAR') {
    chrome.storage.local.get(['webAppUrl', 'secretToken', 'studentId'], async (store) => {
      const targetUrl = store.webAppUrl || CENTRAL_WEB_APP_URL;
      if (!targetUrl || targetUrl.includes('REPLACE')) {
        sendResponse({ success: false, error: 'Web App URL not configured.' });
        return;
      }
      try {
        const res = await postToGoogleAppsScript(targetUrl, {
          action: 'sync_calendar',
          secretToken: store.secretToken || '',
          studentId: store.studentId || 'unassigned',
          timestamp: new Date().toISOString()
        });
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
        studentId: studentId || store.studentId || 'unassigned',
        studentName: studentName || store.studentName || 'VU Student'
      };
      if (count > 0) {
        updates.lastSyncTime = timestamp || new Date().toISOString();
      }
      if (store.lastSyncStatus !== 'unconfigured') {
        updates.lastSyncStatus = 'success';
      }
      await chrome.storage.local.set(updates);
      try { sendResponse({ success: true }); } catch (e) {}
    });
    return true;
  }

  if (request.action === 'TRIGGER_RESYNC_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const activeTab = (activeTabs && activeTabs[0] && activeTabs[0].url && activeTabs[0].url.includes('vu.edu.pk'))
        ? activeTabs[0]
        : null;

      const proceedWithTab = (tab) => {
        if (!tab || !tab.id) {
          syncFromStorageCache(sendResponse);
          return;
        }
        chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_MANUAL_SYNC' }, (tabRes) => {
          if (chrome.runtime.lastError || !tabRes) {
            // Tab was already open before extension reload; programmatically inject scripts
            if (chrome.scripting && tab.id) {
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/extractor.js', 'content/content.js']
              }, () => {
                if (chrome.runtime.lastError) {
                  syncFromStorageCache(sendResponse);
                  return;
                }
                setTimeout(() => {
                  try {
                    chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_MANUAL_SYNC' }, (retryRes) => {
                      if (chrome.runtime.lastError) {}
                      if (retryRes) {
                        try { sendResponse(retryRes); } catch (e) {}
                      } else {
                        syncFromStorageCache(sendResponse);
                      }
                    });
                  } catch (e) {
                    syncFromStorageCache(sendResponse);
                  }
                }, 400);
              });
            } else {
              syncFromStorageCache(sendResponse);
            }
          } else {
            try { sendResponse(tabRes); } catch (e) {}
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
          studentId: store.studentId || 'unassigned',
          studentName: store.studentName || 'VU Student',
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
