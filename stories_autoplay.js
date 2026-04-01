// 自動點擊「查看限時動態」確認按鈕，略過「以...角度檢視」中間畫面
(function () {
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
})();
