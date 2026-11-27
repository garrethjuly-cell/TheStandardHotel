/* Public-facing CMS renderer. Published content only; all text is inserted with textContent. */
(() => {
  'use strict';

  const safeMediaUrl = (value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const v = value.trim();
    if (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return v;
    try {
      const u = new URL(v, window.location.origin);
      return u.protocol === 'https:' ? u.href : '';
    } catch { return ''; }
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const buildCard = (item) => {
    const article = el('article', 'news-card fade');
    const mediaUrl = safeMediaUrl(item.media_url);
    if (mediaUrl && item.media_type === 'image') {
      const wrap = el('div', 'image');
      const img = el('img');
      img.src = mediaUrl;
      img.alt = item.title || 'The Standard Hotel';
      img.loading = 'lazy';
      img.onerror = () => wrap.remove();
      wrap.append(img);
      article.append(wrap);
    } else if (mediaUrl && item.media_type === 'video') {
      const wrap = el('div', 'image');
      const video = el('video');
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = mediaUrl;
      video.setAttribute('aria-label', item.title || 'The Standard Hotel video');
      wrap.append(video);
      article.append(wrap);
    }
    const body = el('div', 'body');
    body.append(el('div', 'tag', 'The Standard Hotel · News & offers'));
    if (item.title) body.append(el('h3', '', item.title));
    if (item.body) body.append(el('p', 'muted', item.body));
    const link = el('a', '', 'Explore rooms →');
    link.href = 'rooms.html';
    body.append(link);
    article.append(body);
    return article;
  };

  const money = (value) => '$' + Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

  async function loadPublicRates() {
    try {
      const [roomResponse, addonResponse] = await Promise.all([
        fetch('/api/public/rooms', { headers: { Accept: 'application/json' } }),
        fetch('/api/public/addons', { headers: { Accept: 'application/json' } })
      ]);
      if (!roomResponse.ok || !addonResponse.ok) return;
      const roomData = await roomResponse.json();
      const addonData = await addonResponse.json();
      if (Array.isArray(roomData.rooms) && typeof rooms !== 'undefined') {
        for (const row of roomData.rooms) {
          const item = rooms.find(r => r.id === row.id);
          if (!item) continue;
          item.name = row.name || item.name;
          if (row.price_single != null && row.price_double != null && ['standard', 'executive'].includes(row.id)) {
            item.priceSingle = Number(row.price_single);
            item.priceDouble = Number(row.price_double);
          } else {
            item.price = Number(row.price_single ?? row.price ?? item.price ?? 0);
          }
        }
        document.querySelectorAll('[data-public-room-name]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.publicRoomName);
          if (r && r.name) node.textContent = r.name;
        });
        document.querySelectorAll('[data-rate-single]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.rateSingle);
          if (r) node.textContent = money(r.price_single);
        });
        document.querySelectorAll('[data-rate-double]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.rateDouble);
          if (r) node.textContent = money(r.price_double);
        });
        document.querySelectorAll('[data-rate-base]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.rateBase);
          if (r) node.textContent = money(r.price_single ?? r.price);
        });
        document.querySelectorAll('[data-rate-single-cell]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.rateSingleCell);
          if (r) node.textContent = money(r.price_single);
        });
        document.querySelectorAll('[data-rate-double-cell]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.rateDoubleCell);
          if (r) node.textContent = money(r.price_double);
        });
        document.querySelectorAll('[data-rate-base-cell]').forEach(node => {
          const r = roomData.rooms.find(x => x.id === node.dataset.rateBaseCell);
          if (!r) return;
          const note = node.querySelector('.table-note');
          if (note && node.firstChild) node.firstChild.textContent = money(r.price_single ?? r.price) + ' ';
          else node.textContent = money(r.price_single ?? r.price);
        });
      }
      if (Array.isArray(addonData.addons) && typeof addOns !== 'undefined') {
        addOns.splice(0, addOns.length, ...addonData.addons.map(a => ({ id: a.id, name: a.name, price: Number(a.price) })));
      }
      window.dispatchEvent(new Event('hotelRatesUpdated'));
    } catch { /* Existing page rates remain visible if the API is unavailable. */ }
  }

  async function loadNews() {
    const grids = [...document.querySelectorAll('[data-cms-section="news"]')];
    if (!grids.length) return;
    try {
      const response = await fetch('/api/public/content?section=news', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      const items = Array.isArray(data.content) ? data.content : [];
      if (!items.length) return; // Keep the original editorial cards as a graceful fallback.
      grids.forEach((grid, index) => {
        grid.replaceChildren(...items.slice(0, index === 0 && grid.id === 'cmsHomeNewsGrid' ? 3 : 12).map(buildCard));
        grid.querySelectorAll('.fade').forEach(card => card.classList.add('visible'));
      });
    } catch { /* Static editorial content remains available when offline. */ }
  }

  async function loadReview() {
    const target = document.querySelector('#cmsFeaturedReview');
    if (!target) return;
    try {
      const response = await fetch('/api/public/reviews', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      const review = Array.isArray(data.reviews) ? data.reviews[0] : null;
      if (!review) return;
      target.replaceChildren();
      target.append(el('div', 'quote', `“${review.explanation}”`));
      const stars = el('p', 'muted', `${'★'.repeat(Math.max(1, Math.min(5, Number(review.rating) || 5)))} · ${review.rating}/5`);
      target.append(stars, el('p', 'muted', `— ${review.guest_name}`));
    } catch { /* Keep the original featured review when offline. */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPublicRates();
    loadNews();
    loadReview();
  });
})();
