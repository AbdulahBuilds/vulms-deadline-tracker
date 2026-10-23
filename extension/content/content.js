/**
 * VULMS Smart Deadline Tracker - Content Script
 * Manages resilient DOM observation, student detection, extraction triggers, and user toasts.
 */

(function () {
  'use strict';

  let hasSuccessfullyExtracted = false;
  let observer = null;
  let pollTimer = null;
  let pollAttempts = 0;
  const MAX_POLL_ATTEMPTS = 12;
  const POLL_INTERVAL_MS = 1200;

  // Visual toast element
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
      document.body.appendChild(container);
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
      max-width: 320px;
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
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  /**
   * Run extraction and communicate with background service worker
   */
  function executeExtraction(isManual = false) {
    if (!window.VulmsExtractor) {
      console.warn('[VULMS Tracker] VulmsExtractor library not yet loaded.');
      return;
    }

    const profile = window.VulmsExtractor.extractStudentProfile ?
      window.VulmsExtractor.extractStudentProfile(document) :
      { studentId: window.VulmsExtractor.extractStudentId(document), studentName: 'VU Student', defaultEmail: '' };

    const studentId = profile.studentId;
    const studentName = profile.studentName;
    const activities = window.VulmsExtractor.extractActivities(document, studentId);

    console.log(`[VULMS Tracker] Extraction scan: studentId=${studentId}, name=${studentName}, found ${activities.length} activities.`);

    if (studentId) {
      chrome.runtime.sendMessage({
        action: 'VULMS_STUDENT_DETECTED',
        data: {
          studentId: studentId,
          studentName: studentName,
          vuEmail: profile.vuEmail || null,
          defaultEmail: profile.vuEmail || profile.defaultEmail || `${studentId}@vu.edu.pk`,
          activities: activities,
          pageUrl: window.location.href,
          timestamp: new Date().toISOString()
        }
      });
    }

    // If official email with initials suffix is not yet found, fetch StudentProfile.aspx in background
    if ((!profile.vuEmail || profile.vuEmail === `${studentId}@vu.edu.pk`) && !window.location.pathname.includes('StudentProfile.aspx')) {
      fetch('/Profile/StudentProfile.aspx', { credentials: 'include' })
        .then(r => r.text())
        .then(html => {
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const fetchedProfile = window.VulmsExtractor.extractStudentProfile(doc);
          if (fetchedProfile && fetchedProfile.vuEmail) {
            chrome.runtime.sendMessage({
              action: 'VULMS_STUDENT_DETECTED',
              data: {
                studentId: fetchedProfile.studentId || studentId,
                studentName: fetchedProfile.studentName || studentName,
                vuEmail: fetchedProfile.vuEmail,
                defaultEmail: fetchedProfile.vuEmail,
                timestamp: new Date().toISOString()
              }
            });
          }
        })
        .catch(() => {});
    }

    if (activities.length > 0) {
      hasSuccessfullyExtracted = true;
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      chrome.runtime.sendMessage({
        action: 'VULMS_ACTIVITIES_EXTRACTED',
        data: {
          studentId: studentId,
          activities: activities,
          pageUrl: window.location.href,
          timestamp: new Date().toISOString()
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[VULMS Tracker] Error sending to background:', chrome.runtime.lastError.message);
          if (isManual) showToast('Sync failed: Could not reach background worker.', 'error');
        } else if (response && response.success) {
          if (isManual || activities.length > 0) {
            showToast(`Synced ${activities.length} activity deadline${activities.length > 1 ? 's' : ''} to Google Sheets!`, 'success');
          }
        }
      });
    } else if (isManual) {
      showToast(`Student ID ${studentId || 'detected'} verified. No pending activities right now.`, 'info');
    }
  }

  /**
   * Initializes resilient observation
   */
  function initObserver() {
    // Immediate attempt
    executeExtraction(false);

    if (hasSuccessfullyExtracted) return;

    // MutationObserver to capture asynchronous AJAX rendering
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          executeExtraction(false);
          if (hasSuccessfullyExtracted) break;
        }
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // Bounded fallback polling
    pollTimer = setInterval(() => {
      pollAttempts++;
      if (hasSuccessfullyExtracted || pollAttempts >= MAX_POLL_ATTEMPTS) {
        clearInterval(pollTimer);
        pollTimer = null;
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      } else {
        executeExtraction(false);
      }
    }, POLL_INTERVAL_MS);
  }

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TRIGGER_MANUAL_SYNC') {
      executeExtraction(true);
      sendResponse({ status: 'started' });
    } else if (message.action === 'GET_PAGE_STATUS') {
      const studentId = window.VulmsExtractor ? window.VulmsExtractor.extractStudentId(document) : null;
      const count = window.VulmsExtractor ? window.VulmsExtractor.extractActivities(document, studentId).length : 0;
      sendResponse({
        isVulms: true,
        studentId: studentId,
        activitiesCount: count,
        extracted: hasSuccessfullyExtracted
      });
    }
    return true;
  });

  // Start observation once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }

})();
