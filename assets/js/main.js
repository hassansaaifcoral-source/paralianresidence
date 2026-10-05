/* ═══════════════════════════════════════════════════════════
   PARALIAN — Shared JavaScript
   ═══════════════════════════════════════════════════════════ */

/* ── Navigation ──────────────────────────────────── */
(function () {
  const nav = document.getElementById('nav');
  const hamburger = document.querySelector('.nav-hamburger');
  const drawer = document.querySelector('.nav-drawer');

  if (!nav) return;

  // Scroll state
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });
  if (window.scrollY > 40) nav.classList.add('scrolled');

  // Hamburger toggle
  if (hamburger && drawer) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      drawer.classList.toggle('open');
    });
    // Close on link click
    drawer.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        hamburger.classList.remove('open');
        drawer.classList.remove('open');
      });
    });
  }

  // Active link
  const page = window.location.pathname.split('/').pop() || 'index.html';
  nav.querySelectorAll('.nav-links a, .nav-drawer a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === page || (page === '' && href === 'index.html') ||
        (href !== '' && page.startsWith(href.replace('.html', '')))) {
      a.classList.add('active');
    }
  });
})();

/* ── Scroll Reveal ───────────────────────────────── */
(function () {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  els.forEach(el => io.observe(el));
})();

/* ── Lightbox ────────────────────────────────────── */
(function () {
  const lb = document.getElementById('lightbox');
  if (!lb) return;
  const lbImg = lb.querySelector('.lb-img');
  const items = [...document.querySelectorAll('[data-lightbox]')];
  let cur = 0;

  function open(idx) {
    cur = idx;
    lbImg.src = items[idx].dataset.lightbox || items[idx].querySelector('img')?.src || '';
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
  }
  function next() { open((cur + 1) % items.length); }
  function prev() { open((cur - 1 + items.length) % items.length); }

  items.forEach((el, i) => el.addEventListener('click', () => open(i)));
  lb.querySelector('.lightbox-close')?.addEventListener('click', close);
  lb.querySelector('.lightbox-next')?.addEventListener('click', next);
  lb.querySelector('.lightbox-prev')?.addEventListener('click', prev);
  lb.addEventListener('click', e => { if (e.target === lb) close(); });

  document.addEventListener('keydown', e => {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
  });
})();

/* ── Toast ───────────────────────────────────────── */
function showToast(msg, type = 'success', duration = 3500) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

/* ── Booking Form ────────────────────────────────── */
(function () {
  const form = document.getElementById('booking-form');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const data = new FormData(form);
    const checkin = data.get('checkin');
    const checkout = data.get('checkout');

    if (!checkin || !checkout) {
      showToast('Please select check-in and check-out dates.', 'error');
      return;
    }
    if (checkout <= checkin) {
      showToast('Check-out must be after check-in.', 'error');
      return;
    }

    const name = (data.get('name') || '').trim();
    const email = (data.get('email') || '').trim();
    if (!name || !email) {
      showToast('Please add your name and email so we can get back to you.', 'error');
      return;
    }

    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const res = await window.ParalianAPI.request('POST', '/enquiries', {
        body: {
          checkin,
          checkout,
          room: data.get('room') || undefined,
          guests: parseInt(data.get('guests'), 10) || 1,
          name,
          email,
          phone: (data.get('phone') || '').trim() || undefined,
        },
      });
      const options = res.availability.filter(a => a.rooms_available > 0 && a.fits_party);
      const first = name.split(' ')[0];
      if (options.length) {
        const best = options[options.length - 1];
        const what = options.length === 1
          ? `${best.name} is available from $${best.price_usd}/night`
          : `${options.length} room types are available from $${best.price_usd}/night`;
        showToast(`✓ Thanks ${first}! ${what}. We'll email you at ${email} to confirm your booking.`, 'success', 7000);
      } else {
        showToast(`Thanks ${first} — we're full for those exact dates, but we've saved your enquiry and will email you alternatives.`, 'success', 7000);
      }
      form.reset();
    } catch (err) {
      showToast(err.message, 'error', 5000);
    } finally {
      btn.disabled = false;
    }
  });
})();

/* ── Contact Form ────────────────────────────────── */
(function () {
  const form = document.getElementById('contact-form');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await window.ParalianAPI.request('POST', '/contact', { body: data });
      showToast('✓ Message received! We\'ll get back to you within 24 hours.', 'success', 5000);
      form.reset();
    } catch (err) {
      showToast(err.message, 'error', 5000);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();

/* ── Smooth scroll for anchor links ─────────────── */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', function (e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 76;
    window.scrollTo({ top: target.offsetTop - offset, behavior: 'smooth' });
  });
});

/* ── Room filter tabs (rooms page) ──────────────── */
(function () {
  const tabs = document.querySelectorAll('[data-filter]');
  const cards = document.querySelectorAll('[data-type]');
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const f = tab.dataset.filter;
      cards.forEach(c => {
        const show = f === 'all' || c.dataset.type === f;
        c.style.display = show ? '' : 'none';
      });
    });
  });
})();

/* ── Date picker min dates ───────────────────────── */
(function () {
  const today = new Date().toISOString().split('T')[0];
  document.querySelectorAll('input[type="date"]').forEach((inp, i) => {
    inp.min = today;
    if (i === 0) {
      inp.addEventListener('change', function () {
        const next = this.parentElement.closest('.booking-form, .contact-form, form')
          ?.querySelectorAll('input[type="date"]')[1];
        if (next && this.value) next.min = this.value;
      });
    }
  });
})();
