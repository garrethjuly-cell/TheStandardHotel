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

  async function loadMediaSlots() {
    try {
      const response = await fetch('/api/public/content?section=media', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const mapping = new Map();
      for (const item of (Array.isArray(data.content) ? data.content : [])) {
        const key = String(item.title || '').trim();
        const url = safeMediaUrl(item.media_url);
        if (key && url) mapping.set(key, { url, type: item.media_type || 'image' });
      }
      document.querySelectorAll('[data-media-slot]').forEach(node => {
        const override = mapping.get(node.dataset.mediaSlot);
        if (!override) return;
        if (node.tagName === 'IMG' && override.type === 'image') {
          node.src = override.url;
          node.removeAttribute('srcset');
        } else if (node.tagName === 'VIDEO' && override.type === 'video') {
          node.src = override.url;
          node.load();
        } else if (node.tagName === 'VIDEO' && override.type === 'image') {
          node.poster = override.url;
        }
      });
    } catch { /* Keep the bundled media if CMS is unavailable. */ }
  }

  async function loadMediaGalleries() {
    const hosts = [...document.querySelectorAll('[data-media-gallery]')];
    if (!hosts.length) return;
    try {
      const response = await fetch('/api/public/content?section=media_gallery', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const items = Array.isArray(data.content) ? data.content : [];
      hosts.forEach(host => {
        const key = host.dataset.mediaGallery;
        const existing = [...host.children];
        const sampleFigure = existing.find(node => node.tagName === 'FIGURE');
        const sampleMedia = sampleFigure?.querySelector('img,video');
        items.filter(item => item.title === key).sort((a,b) => Number(a.id)-Number(b.id)).forEach(item => {
          const url = safeMediaUrl(item.media_url);
          if (!url) return;
          const figure = el('figure', sampleFigure?.className || '');
          const media = item.media_type === 'video' ? el('video', sampleMedia?.className || '') : el('img', sampleMedia?.className || '');
          if (item.media_type === 'video') { media.src=url; media.controls=true; media.preload='metadata'; media.playsInline=true; }
          else { media.src=url; media.alt=item.body || host.dataset.mediaGalleryLabel || 'The Standard Hotel'; media.loading='lazy'; }
          if (sampleMedia?.getAttribute('style')) media.setAttribute('style', sampleMedia.getAttribute('style'));
          figure.append(media);
          if (item.body) figure.append(el('figcaption', sampleFigure?.querySelector('figcaption')?.className || '', item.body));
          host.append(figure);
        });
      });
    } catch { /* Static gallery items remain available when CMS is unavailable. */ }
  }

  async function loadNews() {
    const grids = [...document.querySelectorAll('[data-cms-section="news"]')];
    if (!grids.length) return;
    try {
      const response = await fetch('/api/public/content?section=news', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      const items = Array.isArray(data.content) ? data.content : [];
      grids.forEach((grid) => {
        const limit = grid.id === 'cmsHomeNewsGrid' ? 3 : 12;
        const visibleItems = items.slice(0, limit);
        if (visibleItems.length) {
          grid.replaceChildren(...visibleItems.map(buildCard));
          grid.querySelectorAll('.fade').forEach(card => card.classList.add('visible'));
        } else {
          const empty = el('p', 'muted', 'There are no published news or offers at the moment. Please check back soon.');
          grid.replaceChildren(empty);
        }
      });
    } catch { /* Static editorial content remains available when offline. */ }
  }

  async function loadReview() {
    const target = document.querySelector('#cmsFeaturedReview');
    if (!target) return;
    try {
      const response = await fetch('/api/public/reviews', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const reviews = Array.isArray(data.reviews) ? data.reviews.filter(r => r && r.explanation && r.guest_name) : [];
      const summary = target.closest('.split');
      if (!reviews.length) {
        if (summary) { summary.hidden = true; summary.style.display = 'none'; }
        return;
      }
      if (summary) { summary.hidden = false; summary.style.display = ''; }
      let index = 0;
      const show = () => {
        const review = reviews[index];
        target.replaceChildren();
        const quote = el('div', 'quote', `“${review.explanation}”`);
        quote.setAttribute('aria-live', 'polite');
        target.append(quote);
        const rating = Math.max(1, Math.min(5, Number(review.rating) || 5));
        target.append(el('p', 'muted', `${'★'.repeat(rating)} · ${rating}/5`), el('p', 'muted', `— ${review.guest_name}`));
        const score = summary && summary.querySelector('.review-score');
        const scoreStars = summary && summary.querySelector('.stars');
        const scoreCaption = summary && summary.querySelector('.split > div .muted');
        if (score) score.textContent = `${rating.toFixed(1)} / 5`;
        if (scoreStars) scoreStars.textContent = '★'.repeat(rating) + '☆'.repeat(5 - rating);
        if (scoreCaption) scoreCaption.textContent = `Guest review ${index + 1} of ${reviews.length} · Published reviews`;
        index = (index + 1) % reviews.length;
      };
      show();
      if (reviews.length > 1) {
        if (window.standardReviewCycle) clearInterval(window.standardReviewCycle);
        window.standardReviewCycle = window.setInterval(show, 6500);
      }
    } catch { /* Keep the original featured review when offline. */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPublicRates();
    loadMediaSlots();
    loadMediaGalleries();
    loadNews();
    loadReview();
  });
})();
