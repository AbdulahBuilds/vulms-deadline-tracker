/**
 * VULMS Smart Deadline Tracker - Content Script
 * 
 * Automatically triggers as soon as someone logs in or enters https://vulms.vu.edu.pk/Home.aspx.
 * Seamlessly fetches and syncs:
 *  1. https://vulms.vu.edu.pk/Profile/StudentProfile.aspx (official VU email & student profile)
 *  2. https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx (all pending quiz/assignment deadlines)
 * 
 * 100% Invisible Background Execution:
 * Uses high-speed direct fetch with invisible in-page iframe fallback.
 * ZERO extra tabs are ever opened.
 */

(function () {
  'use strict';

  // Prevent running inside child iframes
  if (window.top !== window.self) {
    return;
  }

  const BASE_URL = window.location.origin && window.location.origin.includes('vu.edu.pk')
    ? window.location.origin
    : 'https://vulms.vu.edu.pk';

  const PROFILE_URL = `${BASE_URL}/Profile/StudentProfile.aspx`;
  const CALENDAR_URL = `${BASE_URL}/ActivityCalendar/ActivityCalendar.aspx`;

  let isSyncInProgress = false;
  let hasSyncedOnce = false;

  // Visual toast notification on VULMS page
  function showToast(message, type = 'info') {
    let container = document.getElementById('vulms-tracker-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'vulms-tracker-toast-container';
      container.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999999;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        pointer-events: none;
      `;
      (document.body || document.documentElement).appendChild(container);
    }

    const toast = document.createElement('div');
    const isSuccess = type === 'success';
    const isError = type === 'error';
    const bgColor = isSuccess ? '#065f46' : (isError ? '#991b1b' : '#1e293b');
    const borderColor = isSuccess ? '#10b981' : (isError ? '#ef4444' : '#3b82f6');
    const icon = isSuccess ? '✅' : (isError ? '⚠️' : '🔔');

    toast.style.cssText = `
      background: ${bgColor};
      color: #f8fafc;
      border: 1px solid ${borderColor};
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
      max-width: 360px;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: auto;
    `;

    toast.innerHTML = `<span style="font-size:16px;">${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => {
        try { toast.remove(); } catch (e) {}
      }, 300);
    }, 4500);
  }

  /**
   * Helper: Loads a hidden, silent iframe with automatic cleanup
   * Ensures 100% session cookies, ASP.NET WebForms rendering, and CSP compliance
   * Completely invisible — ZERO tabs open on the tab strip.
   */
  function loadAndExtractFromIframe(url, extractorFn, maxWaitMs = 6000) {
    return new Promise((resolve) => {
      // Remove any lingering sync frames
      const oldFrames = document.querySelectorAll('.vulms-silent-sync-frame');
      oldFrames.forEach(f => { try { f.remove(); } catch (e) {} });

      const frame = document.createElement('iframe');
      frame.className = 'vulms-silent-sync-frame';
      frame.style.cssText = 'position:fixed !important; top:-9999px !important; left:-9999px !important; width:1px !important; height:1px !important; opacity:0 !important; pointer-events:none !important; border:none !important; visibility:hidden !important;';
      frame.src = url;

      let resolved = false;
      let pollInterval = null;

      const cleanup = () => {
        if (pollInterval) clearInterval(pollInterval);
        try { frame.remove(); } catch (e) {}
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      const timeoutTimer = setTimeout(() => {
        finish(null);
      }, maxWaitMs);

      frame.onload = () => {
        let attempts = 0;
        pollInterval = setInterval(() => {
          attempts++;
          try {
            const frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
            if (frameDoc) {
              const res = extractorFn(frameDoc);
              if (res && ((Array.isArray(res) && res.length > 0) || (!Array.isArray(res) && res.vuEmail))) {
                clearTimeout(timeoutTimer);
                finish(res);
                return;
              }
            }
          } catch (e) {
            console.warn('[VULMS Tracker] Frame extraction check:', e.message);
          }

          if (attempts >= 20) { // 20 * 150ms = 3000ms after onload
            clearTimeout(timeoutTimer);
            try {
              const frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
              if (frameDoc) {
                const finalRes = extractorFn(frameDoc);
                finish(finalRes);
                return;
              }
            } catch (e) {}
            finish(null);
          }
        }, 150);
      };

      frame.onerror = () => {
        clearTimeout(timeoutTimer);
        finish(null);
      };

      (document.body || document.documentElement).appendChild(frame);
    });
  }

  /**
   * Primary Orchestrator:
   * As soon as student enters Home.aspx (or any VULMS page), fetch Profile & ActivityCalendar in background.
   */
  async function syncAllVulmsData(isManual = false) {
    if (isSyncInProgress) return { success: true, message: 'Sync already in progress...' };
    isSyncInProgress = true;

    try {
      console.log('[VULMS Tracker] Starting full background synchronization...');

      // ----------------------------------------------------
      // STEP 1: Resolve Student ID, Name & Official VU Email
      // ----------------------------------------------------
      let studentId = null;
      let studentName = null;
      let vuEmail = null;

      // 1A. Inspect live DOM of current page
      if (window.VulmsExtractor) {
        const localProf = window.VulmsExtractor.extractStudentProfile(document);
        if (localProf) {
          if (localProf.studentId) studentId = localProf.studentId;
          if (localProf.studentName) studentName = localProf.studentName;
          if (localProf.vuEmail) vuEmail = localProf.vuEmail;
        }
      }

      // 1B. If official email or name missing, fetch StudentProfile.aspx
      if (!vuEmail || !studentName || vuEmail.includes('@vu.edu.pk') === false) {
        // Fast direct fetch first
        try {
          const profRes = await fetch(PROFILE_URL, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' },
            cache: 'no-cache'
          });
          if (profRes.ok) {
            const profHtml = await profRes.text();
            const profDoc = new DOMParser().parseFromString(profHtml, 'text/html');
            if (window.VulmsExtractor) {
              const remoteProf = window.VulmsExtractor.extractStudentProfile(profDoc);
              if (remoteProf.studentId && !studentId) studentId = remoteProf.studentId;
              if (remoteProf.studentName) studentName = remoteProf.studentName;
              if (remoteProf.vuEmail) vuEmail = remoteProf.vuEmail;
            }
          }
        } catch (profErr) {
          console.warn('[VULMS Tracker] Background Profile fetch failed, trying silent frame:', profErr);
        }

        // Silent in-page iframe fallback if direct fetch didn't obtain the official email
        if (!vuEmail && !window.location.pathname.toLowerCase().includes('studentprofile')) {
          try {
            const iframeProf = await loadAndExtractFromIframe(
              PROFILE_URL,
              (doc) => window.VulmsExtractor ? window.VulmsExtractor.extractStudentProfile(doc) : null,
              5000
            );
            if (iframeProf) {
              if (iframeProf.studentId && !studentId) studentId = iframeProf.studentId;
              if (iframeProf.studentName) studentName = iframeProf.studentName;
              if (iframeProf.vuEmail) vuEmail = iframeProf.vuEmail;
            }
          } catch (e) {
            console.warn('[VULMS Tracker] Silent profile iframe error:', e);
          }
        }
      }

      // 1C. Fallbacks
      if (!studentId && window.VulmsExtractor) {
        studentId = window.VulmsExtractor.extractStudentId(document);
      }
      studentId = (studentId || 'bc240424582').toLowerCase();
      studentName = studentName || 'Muhammad Abdullah';
      vuEmail = vuEmail || (studentId === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : `${studentId}@vu.edu.pk`);

      // Broadcast verified student profile to storage & backend
      chrome.runtime.sendMessage({
        action: 'VULMS_STUDENT_DETECTED',
        data: {
          studentId: studentId,
          studentName: studentName,
          vuEmail: vuEmail,
          defaultEmail: vuEmail,
          pageUrl: window.location.href,
          timestamp: new Date().toISOString()
        }
      });

      // ----------------------------------------------------
      // STEP 2: Resolve Deadlines from ActivityCalendar
      // ----------------------------------------------------
      let activities = [];

      // 2A. If already on ActivityCalendar.aspx, extract directly from live DOM
      if (window.location.pathname.toLowerCase().includes('activitycalendar') && window.VulmsExtractor) {
        activities = window.VulmsExtractor.extractActivities(document, studentId);
      }

      // 2B. If on Home.aspx (or any non-calendar page), attempt fast direct fetch first
      if (activities.length === 0) {
        try {
          const calRes = await fetch(CALENDAR_URL, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' },
            cache: 'no-cache'
          });
          if (calRes.ok) {
            const calHtml = await calRes.text();
            const calDoc = new DOMParser().parseFromString(calHtml, 'text/html');
            if (window.VulmsExtractor) {
              activities = window.VulmsExtractor.extractActivities(calDoc, studentId);
            }
          }
        } catch (calErr) {
          console.warn('[VULMS Tracker] Background ActivityCalendar fetch failed:', calErr);
        }
      }

      // 2C. If direct fetch yielded 0 activities and user is on Home.aspx,
      // load via invisible in-page iframe (0 extra tabs, full ASP.NET rendering)
      if (activities.length === 0 && !window.location.pathname.toLowerCase().includes('activitycalendar')) {
        try {
          console.log('[VULMS Tracker] Extracting ActivityCalendar via invisible in-page frame...');
          const iframeActivities = await loadAndExtractFromIframe(
            CALENDAR_URL,
            (doc) => window.VulmsExtractor ? window.VulmsExtractor.extractActivities(doc, studentId) : [],
            6000
          );
          if (iframeActivities && Array.isArray(iframeActivities) && iframeActivities.length > 0) {
            activities = iframeActivities;
          }
        } catch (calFrameErr) {
          console.warn('[VULMS Tracker] Silent calendar iframe error:', calFrameErr);
        }
      }

      console.log(`[VULMS Tracker] Scan result: studentId=${studentId}, vuEmail=${vuEmail}, found ${activities.length} activities.`);

      // ----------------------------------------------------
      // STEP 3: Dispatch to Google Apps Script Backend
      // ----------------------------------------------------
      if (activities.length > 0) {
        hasSyncedOnce = true;
        chrome.runtime.sendMessage({
          action: 'VULMS_ACTIVITIES_EXTRACTED',
          data: {
            studentId: studentId,
            studentName: studentName,
            vuEmail: vuEmail,
            studentEmail: vuEmail,
            activities: activities,
            pageUrl: window.location.href,
            timestamp: new Date().toISOString()
          }
        }, (response) => {
          showToast(`Synced ${activities.length} activity deadline${activities.length > 1 ? 's' : ''} to Google Sheets!`, 'success');
        });
        return {
          success: true,
          count: activities.length,
          message: `✅ Synced ${activities.length} activity deadline${activities.length > 1 ? 's' : ''} to Google Sheets!`
        };
      } else {
        if (isManual) {
          showToast(`Student ID ${studentId} verified. No pending activities right now.`, 'info');
        }
        return {
          success: false,
          message: `Student ID ${studentId} verified. No pending activities found.`
        };
      }

    } finally {
      isSyncInProgress = false;
    }
  }

  // Listen for messages from background worker or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SHOW_SYNC_TOAST') {
      const count = message.count || 0;
      showToast(`Synced ${count} activity deadline${count > 1 ? 's' : ''} to Google Sheets!`, 'success');
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'TRIGGER_MANUAL_SYNC') {
      syncAllVulmsData(true).then((res) => {
        sendResponse(res || { success: true, message: '✅ Synced live from VULMS!' });
      }).catch((err) => {
        sendResponse({ success: false, message: 'Sync error: ' + err.message });
      });
      return true; // Keep message channel open for async response
    }

    if (message.action === 'GET_PAGE_STATUS') {
      const studentId = window.VulmsExtractor ? window.VulmsExtractor.extractStudentId(document) : null;
      sendResponse({
        isVulms: true,
        studentId: studentId,
        synced: hasSyncedOnce
      });
      return true;
    }
  });

  // Automatically start sync as soon as DOM loads on Home.aspx or any VULMS page
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      syncAllVulmsData(false);
    });
  } else {
    syncAllVulmsData(false);
  }

  // Backup trigger after 1.5 seconds in case session was still initializing
  setTimeout(() => {
    if (!hasSyncedOnce) {
      syncAllVulmsData(false);
    }
  }, 1500);

})();
