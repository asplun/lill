(function () {
  'use strict';

  function safeColor(value, fallback) {
    var color = String(value || '').trim();
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
  }

  function safePosition(value) {
    return value === 'footer' || value === 'sidebar' ? value : 'top';
  }

  function renderAnnouncement(data) {
    if (!data || !data.enabled || !String(data.text || '').trim()) return;

    var position = safePosition(data.position);
    var targets = document.querySelectorAll('[data-lill-hello="' + position + '"]');
    Array.prototype.forEach.call(targets, function (target) {
      var banner = document.createElement('div');
      banner.className = 'lill-hello-banner';
      banner.setAttribute('role', 'status');
      banner.style.backgroundColor = safeColor(data.bg_color, '#4f46e5');
      banner.style.color = safeColor(data.text_color, '#ffffff');
      banner.textContent = String(data.text);
      target.appendChild(banner);
    });
  }

  fetch('/api/v1/hello', { cache: 'no-store' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (payload) { renderAnnouncement(payload && payload.data); })
    .catch(function () {});
})();
