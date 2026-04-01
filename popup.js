const checkBtn = document.getElementById('checkBtn');
const spinner = document.getElementById('spinner');
const progressText = document.getElementById('progressText');
const summaryRow = document.getElementById('summaryRow');
const keptCountEl = document.getElementById('keptCount');
const closedCountEl = document.getElementById('closedCount');
const tabList = document.getElementById('tabList');
const errorMsg = document.getElementById('errorMsg');

function showLoading() {
  checkBtn.disabled = true;
  checkBtn.textContent = '掃描中...';
  spinner.classList.add('visible');
  progressText.classList.add('visible');
  progressText.textContent = '正在搜尋 Instagram 分頁...';
  summaryRow.classList.remove('visible');
  tabList.classList.remove('visible');
  tabList.innerHTML = '';
  errorMsg.classList.remove('visible');
}

function hideLoading() {
  spinner.classList.remove('visible');
  progressText.classList.remove('visible');
  checkBtn.disabled = false;
  checkBtn.textContent = '🔍 檢查並清理分頁';
}

checkBtn.addEventListener('click', async () => {
  showLoading();

  try {
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    const igTabs = allTabs.filter(tab => tab.url && tab.url.includes('instagram.com'));

    if (igTabs.length === 0) {
      hideLoading();
      errorMsg.textContent = '目前瀏覽器中沒有開啟任何 Instagram 分頁。';
      errorMsg.classList.add('visible');
      return;
    }

    progressText.textContent = `找到 ${igTabs.length} 個 IG 分頁，正在取得限時動態清單...`;

    // ── Step 1: 取得 tray 資料（1次 API 呼叫）────────────────────────
    let trayMap = null;
    try {
      const [trayResult] = await chrome.scripting.executeScript({
        target: { tabId: igTabs[0].id },
        world: 'MAIN',
        func: fetchTrayMap
      });
      trayMap = trayResult.result;
    } catch (e) { /* will be null */ }

    if (!trayMap) {
      hideLoading();
      errorMsg.textContent = '無法取得限時動態清單，請確認已登入 Instagram。';
      errorMsg.classList.add('visible');
      return;
    }

    const activeCount = Object.values(trayMap).filter(v => !v.allSeen).length;
    progressText.textContent = `有 ${activeCount} 位使用者有未看限時動態，正在比對分頁...`;

    const [originalTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const originalTabId = originalTab?.id;

    const reservedPaths = ['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'stories', ''];

    // tabDecisions: tabId → { keep: bool, detail: string, storiesUrl?: string|null }
    // storiesUrl = string → navigate to that URL; null → already on stories; undefined → don't open
    const tabDecisions = new Map();
    const unknownProfileTabs = []; // profile tabs not in tray → need API check

    // ── Step 2: 第一輪分類（使用 tray，不需網路）────────────────────
    for (const tab of igTabs) {
      const tabUrl = tab.url || '';
      const storiesUrlMatch = tabUrl.match(/instagram\.com\/stories\/([^\/]+)/);
      const profileUrlMatch = tabUrl.match(/instagram\.com\/([^\/\?#]+)/);

      if (storiesUrlMatch) {
        const storyUsername = storiesUrlMatch[1];
        const trayEntry = trayMap[storyUsername];
        if (!trayEntry) {
          // 不在 tray（可能未追蹤或 API 截斷）→ 保守保留
          tabDecisions.set(tab.id, { keep: true, detail: `${storyUsername} 不在 tray（可能未追蹤），保留`, storiesUrl: null });
        } else if (trayEntry.allSeen) {
          tabDecisions.set(tab.id, { keep: false, detail: `${storyUsername} 限時動態已全部看完（seen）` });
        } else {
          tabDecisions.set(tab.id, { keep: true, detail: `${storyUsername} 限時動態尚未看完`, storiesUrl: null });
        }
      } else if (profileUrlMatch && !reservedPaths.includes(profileUrlMatch[1])) {
        const username = profileUrlMatch[1];
        const trayEntry = trayMap[username];
        if (trayEntry && !trayEntry.allSeen) {
          tabDecisions.set(tab.id, { keep: true, detail: `${username} 有限時動態（tray）`, storiesUrl: `https://www.instagram.com/stories/${username}/` });
        } else if (trayEntry && trayEntry.allSeen) {
          tabDecisions.set(tab.id, { keep: false, detail: `${username} 限時動態已全部看完（seen）` });
        } else {
          // 不在 tray → 需要 API 查詢
          unknownProfileTabs.push({ tab, username });
        }
      } else {
        tabDecisions.set(tab.id, { keep: true, detail: '非個人檔案頁面，保留' });
      }
    }

    // ── Step 3: 並列取得所有未知分頁的 user ID（不需網路）───────────
    if (unknownProfileTabs.length > 0) {
      progressText.textContent = `正在取得 ${unknownProfileTabs.length} 個未追蹤帳號的 ID...`;

      const userIdResults = await Promise.all(
        unknownProfileTabs.map(({ tab, username }) =>
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: extractUserIdFromPage,
            args: [username]
          }).then(r => r[0]?.result || null).catch(() => null)
        )
      );

      // 整理 username → userId，找不到的另外處理
      const usernameToUserId = {};
      const needsApiIdLookup = []; // userId 從頁面取不到的

      for (let i = 0; i < unknownProfileTabs.length; i++) {
        const { username } = unknownProfileTabs[i];
        const userId = userIdResults[i];
        if (userId) {
          usernameToUserId[username] = userId;
        } else {
          needsApiIdLookup.push(username);
        }
      }

      // ── Step 4: 對無法從頁面取得 ID 的帳號，並列呼叫 web_profile_info ──
      if (needsApiIdLookup.length > 0) {
        progressText.textContent = `正在透過 API 補查 ${needsApiIdLookup.length} 個帳號 ID...`;
        const apiIdResults = await Promise.all(
          needsApiIdLookup.map(username =>
            chrome.scripting.executeScript({
              target: { tabId: igTabs[0].id },
              world: 'MAIN',
              func: fetchUserIdViaApi,
              args: [username]
            }).then(r => r[0]?.result || null).catch(() => null)
          )
        );
        for (let i = 0; i < needsApiIdLookup.length; i++) {
          if (apiIdResults[i]) {
            usernameToUserId[needsApiIdLookup[i]] = apiIdResults[i];
          }
        }
      }

      // ── Step 5: 單次批量 reels_media 查詢（1次 API 呼叫）──────────
      const allUserIds = Object.values(usernameToUserId);
      let reelsResultMap = {}; // userId → { hasUnseen: bool }

      if (allUserIds.length > 0) {
        progressText.textContent = `正在批量查詢 ${allUserIds.length} 個帳號的限時動態...`;
        const [batchResult] = await chrome.scripting.executeScript({
          target: { tabId: igTabs[0].id },
          world: 'MAIN',
          func: fetchReelsMediaBatch,
          args: [allUserIds]
        }).catch(() => [{ result: null }]);
        reelsResultMap = batchResult?.result || {};
      }

      // ── Step 6: 套用結果到未知分頁────────────────────────────────
      for (const { tab, username } of unknownProfileTabs) {
        const userId = usernameToUserId[username];
        if (!userId) {
          tabDecisions.set(tab.id, { keep: true, detail: `${username} 無法取得 ID，保留` });
          continue;
        }
        const reelResult = reelsResultMap[userId];
        if (reelResult === undefined || reelResult === null) {
          tabDecisions.set(tab.id, { keep: true, detail: `${username} 無法判斷，保留` });
        } else if (reelResult.hasUnseen) {
          tabDecisions.set(tab.id, { keep: true, detail: `${username} 有限時動態`, storiesUrl: `https://www.instagram.com/stories/${username}/` });
        } else {
          tabDecisions.set(tab.id, { keep: false, detail: `${username} 無限時動態` });
        }
      }
    }

    // ── Step 7: 整理結果，關閉/保留分頁 ─────────────────────────────
    let keptCount = 0;
    let closedCount = 0;
    const results = [];
    const tabsToClose = [];
    const tabsToOpen = [];

    for (const tab of igTabs) {
      const decision = tabDecisions.get(tab.id);
      if (!decision || decision.keep === false) {
        closedCount++;
        tabsToClose.push(tab.id);
        results.push({ title: tab.title || 'Instagram', status: 'closed', detail: '🗑️ 已關閉 — ' + (decision?.detail || '') });
      } else {
        keptCount++;
        if (decision.storiesUrl !== undefined) {
          tabsToOpen.push({ tabId: tab.id, storiesUrl: decision.storiesUrl });
        }
        results.push({ title: tab.title || 'Instagram', status: 'kept', detail: '✅ 保留 — ' + (decision.detail || '') });
      }
    }

    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose);
    }

    // 所有分頁同時導覽至 stories 頁
    const tabsNeedingNav = tabsToOpen.filter(t => t.storiesUrl);
    await Promise.all(tabsNeedingNav.map(({ tabId, storiesUrl }) =>
      chrome.tabs.update(tabId, { url: storiesUrl })
    ));

    // 對每個分頁個別等待載入完成後再注入
    await Promise.all(tabsToOpen.map(({ tabId, storiesUrl }) =>
      new Promise(resolve => {
        const inject = () => {
          chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: autoClickViewStoriesButton
          }).catch(() => {}).finally(resolve);
        };

        if (!storiesUrl) {
          inject();
          return;
        }

        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(safetyTimer);
            inject();
          }
        };
        const safetyTimer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 10000);
        chrome.tabs.onUpdated.addListener(listener);
      })
    ));

    if (originalTabId) {
      await chrome.tabs.update(originalTabId, { active: true });
    }

    hideLoading();

    keptCountEl.textContent = keptCount;
    closedCountEl.textContent = closedCount;
    summaryRow.classList.add('visible');

    tabList.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'tab-item';
      const icon = r.status === 'kept' ? '✅' : '🗑️';
      item.innerHTML = `
        <span class="tab-status">${icon}</span>
        <div class="tab-info">
          <div class="tab-title">${escapeHtml(r.title)}</div>
          <div class="tab-detail">${escapeHtml(r.detail)}</div>
        </div>
      `;
      tabList.appendChild(item);
    }
    tabList.classList.add('visible');

  } catch (err) {
    hideLoading();
    errorMsg.textContent = '發生錯誤：' + (err.message || '未知錯誤');
    errorMsg.classList.add('visible');
  }
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ════════════════════════════════════════════════════════════════════
// 注入函式（以下全部為 executeScript 注入用，不可引用外部變數）
// ════════════════════════════════════════════════════════════════════

/**
 * 取得 reels tray 資料，回傳 { username: { allSeen: boolean } } map。
 */
async function fetchTrayMap() {
  try {
    const csrftoken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const headers = {
      'x-ig-app-id': '936619743392459',
      'x-asbd-id': '198387',
      'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrftoken': csrftoken
    };

    const trayResp = await fetch('/api/v1/feed/reels_tray/', { headers });
    if (!trayResp.ok) return null;

    const trayData = await trayResp.json();
    const tray = trayData?.tray || [];
    const map = {};
    const norm = ts => (ts > 1e10 ? Math.floor(ts / 1000) : ts);
    for (const reel of tray) {
      const username = reel.user?.username;
      if (username) {
        const seenNorm = norm(reel.seen || 0);
        const latestNorm = norm(reel.latest_reel_media || 0);
        const allSeen = seenNorm > 0 && (latestNorm === 0 || seenNorm >= latestNorm);
        map[username] = { allSeen };
      }
    }
    return map;
  } catch (e) {
    return null;
  }
}

/**
 * 從頁面 DOM / React Fiber / script tag 取得 user ID，不呼叫網路。
 * 回傳 userId 字串或 null。
 */
function extractUserIdFromPage(username) {
  function getValueByKey(obj, key) {
    if (typeof obj !== 'object' || obj === null) return null;
    const stack = [obj];
    const visited = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      try { if (current[key] !== undefined) return current[key]; } catch (e) {}
      try {
        for (const value of Object.values(current)) {
          if (typeof value === 'object' && value !== null) stack.push(value);
        }
      } catch (e) {}
    }
    return null;
  }

  // 1. React Fiber
  for (const sel of ['section', 'div[role="dialog"]']) {
    const el = sel === 'section'
      ? Array.from(document.querySelectorAll('section')).pop()
      : document.querySelector(sel);
    if (el) {
      const fid = getValueByKey(el, 'userId');
      if (fid) return String(fid);
    }
  }

  // 2. Script tag regex
  const idRegexes = [
    new RegExp(`"id":"(\\d+)","username":"${username}"`),
    new RegExp(`"username":"${username}","id":"(\\d+)"`),
    new RegExp(`"pk":"(\\d+)","username":"${username}"`),
    new RegExp(`"username":"${username}","pk":"(\\d+)"`),
  ];
  function searchInText(text) {
    for (const rx of idRegexes) { const m = text.match(rx); if (m) return m[1]; }
    return null;
  }
  for (const sel of ['script[type="application/json"]', 'script:not([type="application/json"])']) {
    for (const s of document.querySelectorAll(sel)) {
      if (s.textContent.includes(username)) {
        const found = searchInText(s.textContent);
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * 透過 web_profile_info API 取得 user ID（網路呼叫，作為 fallback）。
 * 注入至任一 IG 分頁執行。
 */
async function fetchUserIdViaApi(username) {
  try {
    const csrftoken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const headers = {
      'x-csrftoken': csrftoken,
      'x-ig-app-id': '936619743392459',
      'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
      'x-requested-with': 'XMLHttpRequest'
    };
    const r = await fetch(`/api/v1/users/web_profile_info/?username=${username}`, { headers });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.data?.user?.id || null;
  } catch (e) {
    return null;
  }
}

/**
 * 批量查詢多個 user ID 的限時動態狀態（單次 API 呼叫）。
 * userIds: string[]
 * 回傳 { [userId]: { hasUnseen: boolean } | null }
 * null 表示該 userId 資料缺失或 API 未回傳。
 */
async function fetchReelsMediaBatch(userIds) {
  try {
    const csrftoken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const headers = {
      'x-csrftoken': csrftoken,
      'x-ig-app-id': '936619743392459',
      'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
      'x-requested-with': 'XMLHttpRequest'
    };

    // reel_ids 以重複參數傳遞（支援批量）
    const params = new URLSearchParams();
    for (const id of userIds) params.append('reel_ids', id);

    const resp = await fetch(`/api/v1/feed/reels_media/?${params.toString()}`, { headers });
    if (!resp.ok) return {};

    const data = await resp.json();
    const norm = ts => (ts > 1e10 ? Math.floor(ts / 1000) : ts);
    const result = {};

    // API 回傳格式：{ reels_media: [...] } 或 { reels: { userId: reel } }
    let reelsMedia = data?.reels_media || [];
    if (reelsMedia.length === 0 && data?.reels) {
      reelsMedia = Object.values(data.reels);
    }

    for (const reel of reelsMedia) {
      const userId = String(reel.user?.pk || reel.id || '');
      if (!userId) continue;

      if (!reel.items || reel.items.length === 0) {
        result[userId] = { hasUnseen: false }; // 無故事或已過期
        continue;
      }

      const seen = norm(reel.seen || 0);
      const latest = norm(reel.latest_reel_media || 0);

      let hasUnseen;
      if (seen === 0) {
        hasUnseen = true;   // 從未看過
      } else if (latest === 0) {
        hasUnseen = false;  // 無法得知最新時間，視為看完
      } else {
        hasUnseen = seen < latest;
      }
      result[userId] = { hasUnseen };
    }

    // 確保所有查詢的 userId 都有結果
    // API 成功但不在回應中 → 無活躍限時動態（與 API 失敗不同，API 失敗會 throw 並 return {}）
    for (const id of userIds) {
      if (!(id in result)) result[id] = { hasUnseen: false };
    }

    return result;
  } catch (e) {
    return {};
  }
}

/**
 * 注入至 stories 分頁，自動點擊「查看限時動態」確認按鈕。
 */
function autoClickViewStoriesButton() {
  function tryClick() {
    const buttons = document.querySelectorAll('div[role="button"], button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === '查看限時動態') {
        btn.click();
        return true;
      }
    }
    return false;
  }
  if (!tryClick()) {
    const observer = new MutationObserver(() => {
      if (tryClick()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }
}

// Auto-run the check as soon as the popup opens
document.addEventListener('DOMContentLoaded', () => {
  checkBtn.click();
});
