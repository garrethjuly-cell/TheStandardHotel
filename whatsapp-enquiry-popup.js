(function () {
  'use strict';

  if (window.__standardWhatsAppEnquiryPopup) return;
  window.__standardWhatsAppEnquiryPopup = true;

  var HOTEL_WHATSAPP = '263776844999';
  var MODAL_ID = 'standard-wa-enquiry-modal';

  var style = document.createElement('style');
  style.textContent = [
    '#' + MODAL_ID + '{position:fixed;inset:0;z-index:999999;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(10,10,10,.7);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}',
    '#' + MODAL_ID + '.is-open{display:flex}',
    '#' + MODAL_ID + ' *{box-sizing:border-box}',
    '#' + MODAL_ID + ' .wa-card{position:relative;width:100%;max-width:410px;max-height:calc(100vh - 32px);overflow-y:auto;padding:30px 24px 24px;background:#FAF8F3;color:#0A0A0A;border:1px solid #C5A675;border-radius:4px;box-shadow:0 24px 80px rgba(0,0,0,.3);font-family:inherit}',
    '#' + MODAL_ID + ' .wa-eyebrow{margin:0 35px 10px 0;color:#9A7748;font-size:10px;letter-spacing:.17em;text-transform:uppercase}',
    '#' + MODAL_ID + ' .wa-title{margin:0 25px 10px 0;font-family:Georgia,serif;font-size:30px;font-weight:400;line-height:1.2}',
    '#' + MODAL_ID + ' .wa-description{margin:0 0 22px;color:#68645D;font-size:13px;line-height:1.6}',
    '#' + MODAL_ID + ' .wa-close{position:absolute;top:10px;right:12px;width:40px;height:40px;border:0;background:transparent;color:#292722;font-size:29px;cursor:pointer}',
    '#' + MODAL_ID + ' .wa-field{margin-bottom:17px}',
    '#' + MODAL_ID + ' label{display:block;margin-bottom:7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}',
    '#' + MODAL_ID + ' input,#' + MODAL_ID + ' textarea{display:block;width:100%;min-height:47px;padding:12px;border:1px solid #D8D0C3;border-radius:2px;background:#fff;color:#0A0A0A;font:inherit;font-size:14px;outline:none}',
    '#' + MODAL_ID + ' textarea{min-height:110px;resize:vertical}',
    '#' + MODAL_ID + ' input:focus,#' + MODAL_ID + ' textarea:focus{border-color:#9A7748;box-shadow:0 0 0 2px rgba(154,119,72,.13)}',
    '#' + MODAL_ID + ' .wa-submit{width:100%;min-height:49px;padding:13px;border:1px solid #0A0A0A;border-radius:2px;background:#0A0A0A;color:#fff;font:inherit;font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}',
    '#' + MODAL_ID + ' .wa-submit:hover{background:#9A7748;border-color:#9A7748}',
    '#' + MODAL_ID + ' .wa-submit:disabled{opacity:.65;cursor:wait}',
    '#' + MODAL_ID + ' .wa-status{min-height:18px;margin:12px 0 0;font-size:12px;line-height:1.5}',
    '#' + MODAL_ID + ' .wa-status.error{color:#A12525}',
    '#' + MODAL_ID + ' .wa-status.success{color:#28633C}',
    'body.standard-wa-modal-open{overflow:hidden}',
    '@media(max-width:420px){#' + MODAL_ID + ' .wa-card{padding:27px 19px 20px}}'
  ].join('\n');
  document.head.appendChild(style);

  var modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.setAttribute('aria-hidden', 'true');

  var card = document.createElement('section');
  card.className = 'wa-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'standard-wa-title');

  var closeButton = document.createElement('button');
  closeButton.className = 'wa-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close enquiry form');
  closeButton.innerHTML = '&times;';

  var eyebrow = document.createElement('p');
  eyebrow.className = 'wa-eyebrow';
  eyebrow.textContent = 'THE STANDARD HOTEL · BULAWAYO';

  var title = document.createElement('h2');
  title.className = 'wa-title';
  title.id = 'standard-wa-title';
  title.textContent = 'How may we assist?';

  var description = document.createElement('p');
  description.className = 'wa-description';
  description.textContent = 'Enter your phone number and enquiry. We will save your enquiry and open WhatsApp so you can send it to our team.';

  var form = document.createElement('form');
  form.className = 'wa-form';

  var phoneField = document.createElement('div');
  phoneField.className = 'wa-field';

  var phoneLabel = document.createElement('label');
  phoneLabel.htmlFor = 'standard-wa-phone';
  phoneLabel.textContent = 'Phone number';

  var phoneInput = document.createElement('input');
  phoneInput.id = 'standard-wa-phone';
  phoneInput.name = 'phone';
  phoneInput.type = 'tel';
  phoneInput.autocomplete = 'tel';
  phoneInput.inputMode = 'tel';
  phoneInput.maxLength = 30;
  phoneInput.placeholder = '+263 77 123 4567';
  phoneInput.required = true;

  phoneField.appendChild(phoneLabel);
  phoneField.appendChild(phoneInput);

  var messageField = document.createElement('div');
  messageField.className = 'wa-field';

  var messageLabel = document.createElement('label');
  messageLabel.htmlFor = 'standard-wa-message';
  messageLabel.textContent = 'Your enquiry';

  var messageInput = document.createElement('textarea');
  messageInput.id = 'standard-wa-message';
  messageInput.name = 'message';
  messageInput.maxLength = 1500;
  messageInput.placeholder = 'How can our team help you?';
  messageInput.required = true;

  messageField.appendChild(messageLabel);
  messageField.appendChild(messageInput);

  var submitButton = document.createElement('button');
  submitButton.className = 'wa-submit';
  submitButton.type = 'submit';
  submitButton.textContent = 'Send enquiry';

  var status = document.createElement('p');
  status.className = 'wa-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  form.appendChild(phoneField);
  form.appendChild(messageField);
  form.appendChild(submitButton);
  form.appendChild(status);

  card.appendChild(closeButton);
  card.appendChild(eyebrow);
  card.appendChild(title);
  card.appendChild(description);
  card.appendChild(form);
  modal.appendChild(card);
  document.body.appendChild(modal);

  var previousFocus = null;

  function openModal() {
    previousFocus = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('standard-wa-modal-open');
    status.textContent = '';
    status.className = 'wa-status';
    window.setTimeout(function () { phoneInput.focus(); }, 30);
  }

  function closeModal() {
    if (submitButton.disabled) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('standard-wa-modal-open');
    if (previousFocus && typeof previousFocus.focus === 'function') {
      previousFocus.focus();
    }
  }

  closeButton.addEventListener('click', closeModal);

  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeModal();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && modal.classList.contains('is-open')) {
      closeModal();
    }
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;

    var url;
    try {
      url = new URL(link.href);
    } catch (error) {
      return;
    }

    if (url.hostname !== 'wa.me') return;
    if (url.pathname.replace(/\//g, '') !== HOTEL_WHATSAPP) return;

    event.preventDefault();
    openModal();
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!form.reportValidity()) return;

    var phone = phoneInput.value.trim();
    var message = messageInput.value.trim();

    if (phone.replace(/[^\d]/g, '').length < 7) {
      status.textContent = 'Please enter a valid phone number.';
      status.className = 'wa-status error';
      phoneInput.focus();
      return;
    }

    if (!message) {
      status.textContent = 'Please enter your enquiry.';
      status.className = 'wa-status error';
      messageInput.focus();
      return;
    }

    var enquiryText = [
      'Website WhatsApp enquiry — The Standard Hotel',
      'Guest phone number: ' + phone,
      'Enquiry: ' + message
    ].join('\n');

    submitButton.disabled = true;
    submitButton.textContent = 'Saving enquiry…';
    status.textContent = 'Please wait while we save your enquiry.';
    status.className = 'wa-status';

    var whatsappWindow = null;
    try {
      whatsappWindow = window.open('about:blank', '_blank');
    } catch (error) {}

    try {
      var response = await fetch('/api/public/enquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          message: enquiryText,
          source: 'website_whatsapp_popup'
        })
      });

      var result;
      try {
        result = await response.json();
      } catch (error) {
        throw new Error('The server returned an unexpected response.');
      }

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'We could not save your enquiry.');
      }

      status.textContent = 'Enquiry saved. Opening WhatsApp…';
      status.className = 'wa-status success';

      var whatsappUrl = 'https://wa.me/' + HOTEL_WHATSAPP +
        '?text=' + encodeURIComponent(enquiryText);

      if (whatsappWindow && !whatsappWindow.closed) {
        whatsappWindow.location.href = whatsappUrl;
      } else {
        window.location.href = whatsappUrl;
      }

      form.reset();

      window.setTimeout(function () {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('standard-wa-modal-open');
        submitButton.disabled = false;
        submitButton.textContent = 'Send enquiry';
      }, 900);
    } catch (error) {
      if (whatsappWindow && !whatsappWindow.closed) {
        whatsappWindow.close();
      }

      console.error('WhatsApp enquiry failed:', error);
      status.textContent = error.message ||
        'We could not save your enquiry. Please try again.';
      status.className = 'wa-status error';
      submitButton.disabled = false;
      submitButton.textContent = 'Send enquiry';
    }
  });
})();
