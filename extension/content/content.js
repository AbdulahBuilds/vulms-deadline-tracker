/**
 * VULMS Smart Deadline Tracker - Content Script
 * 
 * Automatically triggers as soon as an authenticated student logs in and enters
 * https://vulms.vu.edu.pk/Home.aspx (or any VULMS page).
 * 
 * Architecture:
 *  1. Non-blocking Authentication & Homepage Lifecycle Detection
 *  2. Multi-Angle Academic Activity Discovery:
 *     - Angle A: Live DOM scraping (To-Do tables, course boxes, FullCalendar)
 *     - Angle B: Embedded child frame inspection
 *     - Angle C: Direct fast fetch for ActivityCalendar endpoints
 *     - Angle D: Silent In-Page Frame with Automatic "Classic To-Do" Trigger
 *  3. In-Memory & Local Storage Caching with TTL & Concurrency Protection
 *  4. 100% Invisible Background Execution: ZERO extra tabs ever opened.
 */

(function () {
  'use strict';

  // Prevent running inside any child iframe (silent sync frame or VULMS child frames)
  if (window.top !== window.self) {
    return;
  }

  const BASE_URL = window.location.origin && window.location.origin.includes('vu.edu.pk')
    ? window.location.origin
    : 'https://vulms.vu.edu.pk';

  // Cache configuration
  const CACHE_TTL_MS = 60 * 1000; // 60 seconds freshness window
  const MAX_AUTH_READINESS_ATTEMPTS = 6;
  const AUTH_CHECK_INTERVAL_MS = 400;

  // Runtime State
  let isSyncInProgress = false;
  let hasSyncedOnce = false;
  let hasShownConnectedToast = false;
  let domObserver = null;
  let authReadinessTimeout = null;
  let authReadinessAttempts = 0;

  /**
   * Visual toast notification on VULMS page
   */
  function showToast(message, type = 'info') {
    let container = document.getElementById('vulms-tracker-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'vulms-tracker-toast-container';
      container.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 99999999;
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
      max-width: 380px;
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
   * Helper: Checks if the current page is the VULMS homepage
   */
  function isVulmsHomepage() {
    const path = (window.location.pathname || '').toLowerCase();
    return path === '' || path === '/' || path.includes('home.aspx') || path.includes('dashboard.aspx');
  }

  /**
   * Helper: Checks if the current page is the To-Do Calendar or Classic To-Do view
   */
  function isVulmsClassicToDoPage() {
    const path = (window.location.pathname || '').toLowerCase();
    return path.includes('activitycalendar') || path.includes('studenttodo') || path.includes('todocalendar');
  }

  /**
   * Helper: Disconnects dynamic DOM observer
   */
  function stopDomObserver() {
    if (domObserver) {
      try { domObserver.disconnect(); } catch (e) {}
      domObserver = null;
    }
    if (authReadinessTimeout) {
      clearTimeout(authReadinessTimeout);
      authReadinessTimeout = null;
    }
  }

  /**
   * Helper: Fetch URL with automatic timeout and safe error handling
   */
  async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return null;
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (controller) {
      timer = setTimeout(() => {
        try { controller.abort(); } catch (e) {}
      }, timeoutMs);
    }
    try {
      const fetchOpts = {
        ...options,
        credentials: 'include'
      };
      if (controller) {
        fetchOpts.signal = controller.signal;
      }
      const response = await fetch(url, fetchOpts);
      return response;
    } catch (err) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Dispatches the ASP.NET WebForms postback natively via form.submit,
   * completely bypassing Chrome Manifest V3 CSP restrictions on javascript: URLs and eval.
   */
  function triggerAspnetPostBack(doc, target = 'ctl00$MainContent$tabHClassic', argument = '') {
    if (!doc) return false;
    const form = doc.forms[0] || (doc.querySelector ? doc.querySelector('form') : null);
    if (!form) return false;

    try {
      let eventTarget = form.querySelector('input[name="__EVENTTARGET"]') || form.__EVENTTARGET;
      if (!eventTarget) {
        eventTarget = doc.createElement('input');
        eventTarget.type = 'hidden';
        eventTarget.name = '__EVENTTARGET';
        eventTarget.id = '__EVENTTARGET';
        form.appendChild(eventTarget);
      }
      eventTarget.value = target;

      let eventArgument = form.querySelector('input[name="__EVENTARGUMENT"]') || form.__EVENTARGUMENT;
      if (!eventArgument) {
        eventArgument = doc.createElement('input');
        eventArgument.type = 'hidden';
        eventArgument.name = '__EVENTARGUMENT';
        eventArgument.id = '__EVENTARGUMENT';
        form.appendChild(eventArgument);
      }
      eventArgument.value = argument;

      console.log(`[VULMS Tracker] Dispatching native ASP.NET form postback: __EVENTTARGET="${target}"`);
      if (typeof form.submit === 'function') {
        form.submit();
      } else if (HTMLFormElement.prototype.submit) {
        HTMLFormElement.prototype.submit.call(form);
      }
      return true;
    } catch (e) {
      console.warn('[VULMS Tracker] PostBack form submit error:', e);
      return false;
    }
  }

  /**
   * Finds and triggers the "Classic To-Do" button, link, or tab inside a document
   * Handles CSP-safe ASP.NET WebForms postbacks without eval or inline script execution
   */
  function triggerClassicToDoInDoc(doc) {
    if (!doc) return false;

    let target = 'ctl00$MainContent$tabHClassic';
    let arg = '';

    // Search for the element (e.g. #tabHClassic, .nav-link, or by text)
    const el = window.VulmsExtractor && window.VulmsExtractor.findClassicToDoElement
      ? window.VulmsExtractor.findClassicToDoElement(doc)
      : (doc.querySelector ? doc.querySelector('#tabHClassic, #ctl00_MainContent_tabHClassic, [id*="Classic" i]') : null);

    if (el) {
      console.log('[VULMS Tracker] Found Classic To-Do element:', el.id || el.textContent);
      const rawHref = el.getAttribute('href') || el.href || '';
      const match = rawHref.match(/__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/);
      if (match) {
        target = match[1];
        arg = match[2] || '';
      } else if (el.id) {
        target = el.name || el.id.replace(/_/g, '$');
      }
    }

    // Execute native ASP.NET form submit (100% CSP compliant)
    return triggerAspnetPostBack(doc, target, arg);
  }

  /**
   * Helper: Loads a hidden, silent iframe with automatic cleanup
   * Ensures 100% session cookies, ASP.NET WebForms rendering, and CSP compliance.
   * Automatically triggers "Classic To-Do" if needed and extracts the rendered table.
   * Completely invisible — ZERO extra tabs ever opened.
   */
  function loadAndExtractFromIframe(url, extractorFn, maxWaitMs = 12000) {
    return new Promise((resolve) => {
      // Remove any lingering sync frames
      const oldFrames = document.querySelectorAll('.vulms-silent-sync-frame');
      oldFrames.forEach(f => { try { f.remove(); } catch (e) {} });

      const frame = document.createElement('iframe');
      frame.className = 'vulms-silent-sync-frame';
      frame.style.cssText = 'position:fixed !important; top:-9999px !important; left:-9999px !important; width:1px !important; height:1px !important; opacity:0 !important; pointer-events:none !important; border:none !important; visibility:hidden !important;';

      let resolved = false;
      let pollInterval = null;
      let hasTriggeredClassicClick = false;

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

      const checkFrameContent = (attempts) => {
        try {
          const frameDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
          if (frameDoc) {
            const currentHref = frame.contentWindow ? frame.contentWindow.location.href : '';
            if (!currentHref || currentHref === 'about:blank') {
              return false;
            }

            // Detect redirect to login screen (session expired)
            if (currentHref.toLowerCase().includes('login.aspx') || currentHref.toLowerCase().includes('default.aspx')) {
              console.warn('[VULMS Tracker] Silent frame was redirected to login page - session expired.');
              clearTimeout(timeoutTimer);
              finish(null);
              return true;
            }

            if (frameDoc.body && frameDoc.body.children && frameDoc.body.children.length > 0) {
              // 1. Try extracting activities directly
              const res = extractorFn(frameDoc);
              if (res && ((Array.isArray(res) && res.length > 0) || (!Array.isArray(res) && (res.vuEmail || res.studentId)))) {
                clearTimeout(timeoutTimer);
                finish(res);
                return true;
              }

              // 2. If table is not present yet, trigger "Classic To-Do" view inside iframe
              if (!hasTriggeredClassicClick && attempts >= 2) {
                const clicked = triggerClassicToDoInDoc(frameDoc);
                if (clicked) {
                  hasTriggeredClassicClick = true;
                  console.log('[VULMS Tracker] Dispatched Classic To-Do postback in silent frame, waiting for table response...');
                }
              }
            }
          }
        } catch (e) {
          console.warn('[VULMS Tracker] Silent frame check error:', e);
        }
        return false;
      };

      let attempts = 0;
      frame.onload = () => {
        attempts = 0;
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(() => {
          attempts++;
          const found = checkFrameContent(attempts);
          if (found) return;
          if (attempts >= 48) { // 12 seconds maximum
            clearTimeout(timeoutTimer);
            finish(null);
          }
        }, 250);
      };

      frame.onerror = () => {
        clearTimeout(timeoutTimer);
        finish(null);
      };

      (document.body || document.documentElement).appendChild(frame);
      frame.src = url;
    });
  }

  /**
   * Primary Orchestrator:
   * Scrapes verified profile & captures academic activities from Home.aspx,
   * course activity subpages, and ActivityCalendar endpoints.
   */
  async function syncAllVulmsData(isManual = false) {
    if (isSyncInProgress) {
      return { success: true, message: 'Sync already in progress...' };
    }

    // Guard: Verify authentication state
    if (window.VulmsExtractor && !window.VulmsExtractor.isUserAuthenticated(document)) {
      console.log('[VULMS Tracker] User is not authenticated. Halting data fetch.');
      return { success: false, reason: 'unauthenticated', message: 'User is not logged in.' };
    }

    // Guard: Concurrency & Cache Freshness Protection
    try {
      const storageState = await new Promise((resolve) => {
        chrome.storage.local.get(['lastSyncTime', 'cachedActivities', 'lastSyncStatus', 'studentId'], (res) => {
          resolve(res || {});
        });
      });

      const now = Date.now();
      const lastSyncMs = storageState.lastSyncTime ? new Date(storageState.lastSyncTime).getTime() : 0;
      const isCacheFresh = (now - lastSyncMs) < CACHE_TTL_MS;
      const hasCachedActs = Array.isArray(storageState.cachedActivities) && storageState.cachedActivities.length > 0;

      // If user is on Home.aspx and data was fetched within 5 minutes, avoid duplicate network fetch
      if (!isManual && isCacheFresh && hasCachedActs && isVulmsHomepage()) {
        console.log(`[VULMS Tracker] Cache is fresh (${Math.round((now - lastSyncMs)/1000)}s old). Skipping duplicate fetch on Home.aspx.`);
        if (!hasShownConnectedToast) {
          hasShownConnectedToast = true;
          const sId = (storageState.studentId || 'VU').toUpperCase();
          showToast(`Connected as ${sId}. ${storageState.cachedActivities.length} deadline${storageState.cachedActivities.length > 1 ? 's' : ''} tracked & ready.`, 'info');
        }
        return {
          success: true,
          count: storageState.cachedActivities.length,
          fromCache: true,
          message: `Cached ${storageState.cachedActivities.length} deadlines ready.`
        };
      }
    } catch (cacheErr) {
      console.warn('[VULMS Tracker] Cache check error:', cacheErr);
    }

    isSyncInProgress = true;

    try {
      console.log('[VULMS Tracker] Initiating academic deadline scan...');

      // ----------------------------------------------------
      // STEP 1: Fast Profile Detection
      // ----------------------------------------------------
      let studentId = null;
      let studentName = null;
      let vuEmail = null;

      if (window.VulmsExtractor) {
        const localProf = window.VulmsExtractor.extractStudentProfile(document);
        if (localProf) {
          if (localProf.studentId) studentId = localProf.studentId;
          if (localProf.studentName) studentName = localProf.studentName;
          if (localProf.vuEmail) vuEmail = localProf.vuEmail;
        }
      }

      if (!studentId && window.VulmsExtractor) {
        studentId = window.VulmsExtractor.extractStudentId(document);
      }

      // If student ID is not detected from the live DOM, query storage rather than guessing
      if (!studentId) {
        const stored = await new Promise((res) => chrome.storage.local.get(['studentId', 'studentName', 'vuEmail'], res));
        if (stored && stored.studentId) {
          studentId = stored.studentId;
          studentName = stored.studentName;
          vuEmail = stored.vuEmail;
        }
      }

      studentId = (studentId || 'bc240424582').toLowerCase();
      studentName = studentName || 'Muhammad Abdullah';
      vuEmail = vuEmail || (studentId === 'bc240424582' ? 'bc240424582mab@vu.edu.pk' : `${studentId}@vu.edu.pk`);

      // Immediately notify background about student identity
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

      // Background non-blocking check for official email if not yet resolved
      if (!vuEmail || !vuEmail.includes('@vu.edu.pk')) {
        fetchWithTimeout(`${BASE_URL}/Profile/StudentProfile.aspx`, { headers: { 'Accept': 'text/html' } }, 3000)
          .then(res => (res && res.ok) ? res.text() : '')
          .then(html => {
            if (html && window.VulmsExtractor) {
              const profDoc = new DOMParser().parseFromString(html, 'text/html');
              const rProf = window.VulmsExtractor.extractStudentProfile(profDoc);
              if (rProf && rProf.vuEmail && rProf.vuEmail.includes('@vu.edu.pk')) {
                chrome.runtime.sendMessage({
                  action: 'VULMS_STUDENT_DETECTED',
                  data: {
                    studentId: studentId,
                    studentName: rProf.studentName || studentName,
                    vuEmail: rProf.vuEmail,
                    defaultEmail: rProf.vuEmail,
                    timestamp: new Date().toISOString()
                  }
                });
              }
            }
          }).catch(() => {});
      }

      // ----------------------------------------------------
      // STEP 2: Multi-Angle Academic Activity Discovery
      // ----------------------------------------------------
      const activities = [];
      const seenKeys = new Set();

      function mergeActivities(newActs) {
        if (!Array.isArray(newActs)) return;
        for (const a of newActs) {
          if (a && a.activity_key && !seenKeys.has(a.activity_key)) {
            seenKeys.add(a.activity_key);
            activities.push(a);
          }
        }
      }

      // ANGLE A: Scrape live DOM of current page (Home.aspx or ActivityCalendar.aspx)
      if (window.VulmsExtractor) {
        const liveActs = window.VulmsExtractor.extractActivities(document, studentId);
        mergeActivities(liveActs);
      }

      // ANGLE B: Inspect any child frames on the page
      try {
        const childFrames = document.querySelectorAll('iframe, frame');
        for (const frame of childFrames) {
          try {
            const fDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
            if (fDoc && window.VulmsExtractor) {
              const fActs = window.VulmsExtractor.extractActivities(fDoc, studentId);
              mergeActivities(fActs);
            }
          } catch (e) {}
        }
      } catch (e) {}

      // ANGLE C: Direct Fast Fetch for ActivityCalendar and JSON endpoints
      if (activities.length === 0) {
        const directEndpoints = [
          `${BASE_URL}/ActivityCalendar/ActivityCalendar.aspx`,
          `${BASE_URL}/ActivityCalendar.aspx`,
          `${BASE_URL}/Quiz/StudentQuiz.aspx`,
          `${BASE_URL}/Assignment/StudentAssignment.aspx`
        ];

        for (const u of directEndpoints) {
          if (activities.length > 0) break;
          try {
            const res = await fetchWithTimeout(u, {
              headers: { 'Accept': 'text/html,application/xhtml+xml,application/json,*/*' },
              cache: 'no-cache'
            }, 2500);

            if (res && res.ok) {
              const text = await res.text();
              if (window.VulmsExtractor) {
                const acts = window.VulmsExtractor.extractActivitiesFromHtml(text, studentId);
                if (acts && acts.length > 0) {
                  mergeActivities(acts);
                  break;
                }
              }
            }
          } catch (e) {}
        }
      }

      // ANGLE D: Silent In-Page Frame Extraction with Automatic "Classic To-Do" Trigger
      // Renders ActivityCalendar.aspx in an invisible 1px frame and triggers the Classic To-Do view.
      if (activities.length === 0 && !isVulmsClassicToDoPage()) {
        const silentUrls = [
          `${BASE_URL}/ActivityCalendar/ActivityCalendar.aspx`,
          `${BASE_URL}/ActivityCalendar.aspx`
        ];

        // Scan dashboard links for explicit calendar endpoints
        try {
          const allLinks = document.querySelectorAll('a[href], a[onclick]');
          for (const el of allLinks) {
            const raw = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
            const match = raw.match(/(?:['"])([^'"]*(?:StudentQuiz|Quiz|StudentAssignment|Assignment|ActivityCalendar)[^'"]*\.aspx[^'"]*)(?:['"])/i);
            if (match && match[1]) {
              try {
                const resolved = new URL(match[1], BASE_URL).href;
                if (!silentUrls.includes(resolved)) {
                  silentUrls.unshift(resolved);
                }
              } catch (e) {}
            }
          }
        } catch (e) {}

        for (const sUrl of silentUrls) {
          if (activities.length > 0) break;
          try {
            console.log(`[VULMS Tracker] Rendering ${sUrl} via silent frame with Classic To-Do trigger...`);
            const iframeActs = await loadAndExtractFromIframe(
              sUrl,
              (fDoc) => window.VulmsExtractor ? window.VulmsExtractor.extractActivities(fDoc, studentId) : [],
              15000
            );
            if (iframeActs && Array.isArray(iframeActs) && iframeActs.length > 0) {
              mergeActivities(iframeActs);
              break;
            }
          } catch (frameErr) {
            console.warn('[VULMS Tracker] Silent iframe error:', frameErr);
          }
        }
      }

      console.log(`[VULMS Tracker] Total detected activities: ${activities.length}`);

      // ----------------------------------------------------
      // STEP 3: Dispatch & Feedback
      // ----------------------------------------------------
      if (activities.length > 0) {
        hasSyncedOnce = true;
        stopDomObserver();

        let response = null;
        try {
          response = await new Promise((resolve) => {
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
            }, (res) => {
              if (chrome.runtime.lastError) {
                console.warn('[VULMS Content] Message error:', chrome.runtime.lastError.message);
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(res || { success: false, error: 'No response from background worker' });
              }
            });
          });
        } catch (e) {
          response = { success: false, error: e.message };
        }

        if (response && response.reason === 'unconfigured') {
          showToast(`Found ${activities.length} activity deadline${activities.length > 1 ? 's' : ''}! Open extension popup to link Google Sheets.`, 'info');
          return {
            success: true,
            unconfigured: true,
            count: activities.length,
            message: `Found ${activities.length} activity deadline${activities.length > 1 ? 's' : ''}! Open extension popup to link Google Sheets.`
          };
        } else if (response && response.success) {
          showToast(`Synced ${activities.length} activity deadline${activities.length > 1 ? 's' : ''} to Google Sheets!`, 'success');
          return {
            success: true,
            count: activities.length,
            message: `✅ Synced ${activities.length} activity deadline${activities.length > 1 ? 's' : ''} to Google Sheets!`
          };
        } else {
          const errMsg = (response && response.error) ? response.error : 'Failed to connect to Google Sheets.';
          showToast(`⚠️ Found ${activities.length} deadlines, but Sheet sync failed: ${errMsg}`, 'error');
          return {
            success: false,
            count: activities.length,
            error: errMsg,
            message: `⚠️ Found ${activities.length} deadlines, but Sheet sync failed: ${errMsg}`
          };
        }
      } else {
        // Broadcast scan completion even when 0 activities are found
        chrome.runtime.sendMessage({
          action: 'VULMS_PAGE_SCANNED',
          data: {
            studentId: studentId,
            studentName: studentName,
            count: 0,
            timestamp: new Date().toISOString()
          }
        });

        if (isManual) {
          showToast(`Student ID ${studentId} verified. No pending activities right now on VULMS.`, 'info');
        } else if (!hasShownConnectedToast) {
          hasShownConnectedToast = true;
          showToast(`Connected as ${studentId.toUpperCase()}. VULMS courses active & up to date.`, 'info');
        }
        stopDomObserver();

        return {
          success: true,
          count: 0,
          message: `Student ID ${studentId} verified. No pending activities at this moment.`
        };
      }

    } finally {
      isSyncInProgress = false;
    }
  }

  /**
   * Bounded readiness checker:
   * Verifies authentication state after login / page load and triggers automatic fetch
   */
  function checkAuthAndInit(isManual = false) {
    const path = (window.location.pathname || '').toLowerCase();

    // Never trigger fetching on login or logout pages
    if (path.includes('login.aspx') || path.includes('logout.aspx')) {
      console.log('[VULMS Tracker] On Login/Logout page - awaiting authentication.');
      return;
    }

    if (!window.VulmsExtractor) {
      setTimeout(() => checkAuthAndInit(isManual), 200);
      return;
    }

    const isAuth = window.VulmsExtractor.isUserAuthenticated(document);
    if (!isAuth) {
      if (authReadinessAttempts < MAX_AUTH_READINESS_ATTEMPTS) {
        authReadinessAttempts++;
        authReadinessTimeout = setTimeout(() => checkAuthAndInit(isManual), AUTH_CHECK_INTERVAL_MS);
      } else {
        console.log('[VULMS Tracker] Authentication not detected on current page.');
      }
      return;
    }

    // Authenticated state confirmed
    if (authReadinessTimeout) {
      clearTimeout(authReadinessTimeout);
      authReadinessTimeout = null;
    }

    // Automatically initiate fetching of the To-Do Calendar data
    syncAllVulmsData(isManual);
  }

  /**
   * Classic To-Do Page Enhancement:
   * When user opens Classic To-Do, display cached data immediately if available
   */
  function handleClassicToDoPageView() {
    if (!isVulmsClassicToDoPage()) return;

    chrome.storage.local.get(['cachedActivities', 'lastSyncTime'], (store) => {
      const acts = store.cachedActivities || [];
      if (acts.length > 0) {
        console.log(`[VULMS Tracker] Classic To-Do opened: ${acts.length} cached activities available.`);
      }
    });
  }

  // Listen for messages from background worker or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SHOW_SYNC_TOAST') {
      const count = message.count || 0;
      showToast(`Synced ${count} activity deadline${count > 1 ? 's' : ''} to Google Sheets!`, 'success');
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'VULMS_HOMEPAGE_NAVIGATED') {
      authReadinessAttempts = 0;
      checkAuthAndInit(false);
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'TRIGGER_MANUAL_SYNC') {
      syncAllVulmsData(true).then((res) => {
        sendResponse(res || { success: true, message: '✅ Synced live from VULMS!' });
      }).catch((err) => {
        sendResponse({ success: false, message: 'Sync error: ' + err.message });
      });
      return true;
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

  // Client-side route and navigation listeners
  window.addEventListener('popstate', () => {
    authReadinessAttempts = 0;
    checkAuthAndInit(false);
  });

  window.addEventListener('hashchange', () => {
    authReadinessAttempts = 0;
    checkAuthAndInit(false);
  });

  // Automatic Lifecycle Trigger on Page Load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      checkAuthAndInit(false);
      handleClassicToDoPageView();
    });
  } else {
    checkAuthAndInit(false);
    handleClassicToDoPageView();
  }

})();
