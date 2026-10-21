(function () {
  'use strict';

  var app = document.getElementById('lill-app');
  if (!app) return;
  var shell = app.querySelector('.sr-shell');
  if (!shell) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mobile = window.matchMedia('(max-width: 620px)');
  var ease = 'cubic-bezier(.23,1,.32,1)';
  var themeRoot = '/themes/solbrin/';
  var fallbackImage = themeRoot + 'assets/home-mist.jpg';

  function one(selector, parent) {
    return (parent || shell).querySelector(selector);
  }

  function all(selector, parent) {
    return Array.prototype.slice.call((parent || shell).querySelectorAll(selector));
  }

  function safeImage(value, fallback) {
    var url = String(value || '').trim();
    if (!url || /^(?:javascript|data:text\/html)/i.test(url)) return fallback || fallbackImage;
    return url;
  }

  function addImageFallback(image, fallback) {
    if (!image) return;
    image.addEventListener('error', function () {
      if (image.dataset.fallbackApplied === '1') return;
      image.dataset.fallbackApplied = '1';
      image.src = safeImage(fallback, fallbackImage);
    });
  }

  function initSidebar() {
    var sidebar = one('#sr-sidebar');
    if (!sidebar) return;
    var scrim = one('.sr-scrim');
    var open = all('[data-sr-sidebar-open]');
    var close = all('[data-sr-sidebar-close]');
    var active = null;

    function setOpen(show, restore) {
      sidebar.classList.toggle('is-open', show);
      sidebar.setAttribute('aria-hidden', String(!show));
      sidebar.inert = !show;
      shell.classList.toggle('is-sidebar-open', show);
      open.forEach(function (button) { button.setAttribute('aria-expanded', String(show)); });
      if (scrim) {
        scrim.hidden = !show;
        requestAnimationFrame(function () {
          scrim.style.opacity = show ? '1' : '0';
        });
      }
      if (show) {
        active = document.activeElement;
        var first = sidebar.querySelector('input, a, button');
        if (first) window.setTimeout(function () { first.focus(); }, 60);
      } else {
        if (scrim) window.setTimeout(function () { if (!sidebar.classList.contains('is-open')) scrim.hidden = true; }, 220);
        if (restore && active && typeof active.focus === 'function') active.focus();
      }
    }

    open.forEach(function (button) {
      button.addEventListener('click', function () { setOpen(true); });
    });
    close.forEach(function (button) {
      button.addEventListener('click', function () { setOpen(false, true); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && sidebar.classList.contains('is-open')) setOpen(false, true);
    });
  }

  function initComments() {
    var form = one('.lill-comment-form');
    if (!form) return;
    var parent = form.querySelector('[name="parentId"]');
    var target = form.querySelector('.sr-reply-target');
    var content = form.querySelector('[name="content"]');
    var cancel = form.querySelector('[data-sr-cancel-reply]');

    function cancelReply() {
      if (parent) parent.value = '';
      if (target) target.hidden = true;
    }

    all('[data-sr-reply]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (!parent || !target || !content) return;
        parent.value = button.getAttribute('data-comment-id') || '';
        var label = target.querySelector('span');
        if (label) label.textContent = '正在回复 ' + (button.getAttribute('data-comment-author') || '');
        target.hidden = false;
        content.focus();
      });
    });
    if (cancel) cancel.addEventListener('click', function () {
      cancelReply();
      if (content) content.focus();
    });
    form.addEventListener('reset', function () { window.setTimeout(cancelReply, 0); });
  }

  function initNavigation() {
    var root = document.documentElement;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var rails = [
      { nav: one('.rail .nav'), axis: 'y' },
      { nav: one('.mobile-rail'), axis: 'x' }
    ].filter(function (item) { return item.nav; });
    var instances = [];

    root.dataset.rail = 'icons';

    function makeIndicator(nav, axis) {
      var indicator = one('.nav-indicator', nav);
      var rail = nav.closest('.rail') || nav;
      var glow = one('.nav-glow', rail);
      var links = all('a[data-nav-link]', nav);
      if (!indicator || !links.length) return null;

      var horizontal = axis === 'x';
      var lightColors = ['#115E59', '#0369A1', '#B45309', '#047857'];
      var darkColors = ['#5EEAD4', '#7DD3FC', '#FCD34D', '#6EE7B7'];
      var position = { x: 0, target: 0, velocity: 0 };
      var length = { x: 48, target: 48, velocity: 0 };
      var frame = 0;
      var lastTime = 0;
      var pending = 0;

      function colors() {
        return root.dataset.page === 'home' && root.dataset.hero !== 'scrolled'
          ? darkColors
          : (root.classList.contains('lill-dark') ? darkColors : lightColors);
      }

      function paintAccents() {
        var palette = colors();
        links.forEach(function (link, index) {
          link.style.setProperty('--nav-accent', palette[index % palette.length]);
        });
      }

      function step(spring, stiffness, damping, delta) {
        var acceleration = stiffness * stiffness * (spring.target - spring.x) - 2 * damping * stiffness * spring.velocity;
        spring.velocity += acceleration * delta;
        spring.x += spring.velocity * delta;
        if (Math.abs(spring.target - spring.x) < .0015 && Math.abs(spring.velocity) < .02) {
          spring.x = spring.target;
          spring.velocity = 0;
        }
        return spring.x;
      }

      function animate(time) {
        var delta = lastTime ? Math.min((time - lastTime) / 1000, .032) : .016;
        lastTime = time;
        var y = step(position, 18, .82, delta);
        var size = step(length, 14, .7, delta);
        rail.style.setProperty('--nav-indicator-y', y.toFixed(2) + 'px');
        rail.style.setProperty('--nav-indicator-len', size.toFixed(2) + 'px');
        if (position.x === position.target && length.x === length.target) {
          frame = 0;
          lastTime = 0;
          return;
        }
        frame = window.requestAnimationFrame(animate);
      }

      function moveTo(link) {
        var first = !indicator.classList.contains('is-visible');
        var navBox = nav.getBoundingClientRect();
        var linkBox = link.getBoundingClientRect();
        var offset = horizontal ? linkBox.left - navBox.left : linkBox.top - navBox.top;
        var size = horizontal ? linkBox.width : linkBox.height;
        position.target = offset;
        length.target = size;

        if (first || reduceMotion.matches) {
          position.x = position.target;
          position.velocity = 0;
          length.x = length.target;
          length.velocity = 0;
          rail.style.setProperty('--nav-indicator-y', offset.toFixed(2) + 'px');
          rail.style.setProperty('--nav-indicator-len', size.toFixed(2) + 'px');
        } else if (!frame) {
          lastTime = 0;
          frame = window.requestAnimationFrame(animate);
        }

        rail.style.setProperty('--nav-indicator-color', getComputedStyle(link).getPropertyValue('--nav-accent').trim() || colors()[0]);
        indicator.classList.add('is-visible');
        if (glow) glow.classList.add('is-visible');
      }

      function hide() {
        indicator.classList.remove('is-visible');
        if (glow) glow.classList.remove('is-visible');
        rail.style.setProperty('--nav-indicator-len', '0px');
      }

      function sync() {
        paintAccents();
        var current = one('a[data-nav-link][aria-current="page"]', nav);
        if (current) moveTo(current);
        else hide();
      }

      function returnToCurrent() {
        if (pending) window.cancelAnimationFrame(pending);
        pending = window.requestAnimationFrame(function () {
          pending = 0;
          var current = one('a[data-nav-link][aria-current="page"]', nav);
          if (current) moveTo(current);
          else hide();
        });
      }

      links.forEach(function (link) {
        link.addEventListener('mouseenter', function () { moveTo(link); });
        link.addEventListener('focus', function () { moveTo(link); });
      });
      nav.addEventListener('mouseleave', returnToCurrent);
      nav.addEventListener('focusout', function (event) {
        if (!nav.contains(event.relatedTarget)) returnToCurrent();
      });
      sync();
      return { sync: sync };
    }

    rails.forEach(function (item) {
      var instance = makeIndicator(item.nav, item.axis);
      if (instance) instances.push(instance);
    });

    var repaint = function () {
      instances.forEach(function (instance) { instance.sync(); });
    };
    if (window.MutationObserver) {
      new MutationObserver(repaint).observe(root, { attributes: true, attributeFilter: ['class', 'data-page', 'data-hero'] });
    }
    window.addEventListener('resize', function () {
      window.setTimeout(repaint, 120);
    });

    var lastY = window.scrollY;
    var scrollFrame = 0;
    function updateNavVisibility() {
      scrollFrame = 0;
      var y = window.scrollY;
      var delta = y - lastY;
      if (mobile.matches) {
        if (Math.abs(delta) < 8) return;
        lastY = y;
        root.dataset.dock = delta > 0 && y > 160 ? 'hidden' : 'shown';
        return;
      }
      if (root.dataset.hero === 'top') {
        root.dataset.railReveal = 'expanded';
        lastY = y;
        return;
      }
      if (Math.abs(delta) < (delta > 0 ? 8 : 3)) return;
      lastY = y;
      root.dataset.railReveal = delta > 0 && y > 160 ? 'collapsed' : 'expanded';
    }
    window.addEventListener('scroll', function () {
      if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updateNavVisibility);
    }, { passive: true });
    updateNavVisibility();
  }

  function initReader() {
    var reading = one('.sr-reading--post');
    if (!reading) return;

    var root = document.documentElement;
    root.dataset.page = 'post';
    delete root.dataset.hero;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    var prose = one('.prose', reading);
    var toc = one('[data-sr-toc]', reading);
    var tocNav = one('[data-sr-toc-list]', reading);
    var tocLinks = [];
    var tocTargets = [];
    var observer = null;

    function setCurrentToc(id) {
      tocLinks.forEach(function (link, index) {
        link.classList.toggle('is-current', tocTargets[index].id === id);
      });
    }

    function buildToc() {
      if (!prose || !toc || !tocNav) return;
      tocNav.textContent = '';
      tocLinks = [];
      tocTargets = [];
      var headings = all('h2, h3', prose);
      if (!headings.length) {
        toc.hidden = true;
        return;
      }

      headings.forEach(function (heading, index) {
        if (!heading.id) heading.id = 'sec-' + (index + 1);
        heading.style.scrollMarginTop = '32px';
        var link = document.createElement('a');
        link.href = '#' + heading.id;
        link.textContent = heading.textContent;
        link.dataset.level = heading.tagName === 'H3' ? '3' : '2';
        link.addEventListener('click', function (event) {
          event.preventDefault();
          heading.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
          setCurrentToc(heading.id);
        });
        tocNav.appendChild(link);
        tocLinks.push(link);
        tocTargets.push(heading);
      });
      toc.hidden = false;

      if (observer) observer.disconnect();
      if (window.IntersectionObserver) {
        observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) setCurrentToc(entry.target.id);
          });
        }, { rootMargin: '-18% 0px -68%', threshold: 0 });
        tocTargets.forEach(function (heading) { observer.observe(heading); });
      }
    }

    var progress = one('[data-sr-progress]', reading);
    function updateProgress() {
      if (!progress) return;
      var span = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = span > 0 ? Math.min(1, Math.max(0, window.scrollY / span)) : 0;
      progress.style.transform = 'scaleX(' + ratio + ')';
      progress.style.opacity = ratio >= .99 ? String(Math.max(0, (1 - ratio) * 100)) : '1';
      progress.classList.toggle('is-active', true);
    }

    var feedback = one('[data-reader-feedback]', reading);
    function say(message) {
      if (feedback) feedback.textContent = message || '';
    }

    var settings = {
      fontSize: { min: 15, max: 21, step: 1, def: 17, css: '--post-font-size', format: function (value) { return Math.round(value) + ' px'; }, unit: 'px' },
      lineHeight: { min: 1.55, max: 2.05, step: .05, def: 1.8, css: '--post-line-height', format: function (value) { return value.toFixed(2); }, unit: '' },
      contentWidth: { min: 640, max: 860, step: 10, def: 750, css: '--post-measure', format: function (value) { return Math.round(value) + ' px'; }, unit: 'px' }
    };
    var storageKey = 'solbrin-reader-prefs';
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch (error) {}
    var preferences = {};

    function applySetting(key, inputValue, save) {
      var setting = settings[key];
      var value = Number(inputValue);
      if (!Number.isFinite(value)) value = setting.def;
      value = Math.min(setting.max, Math.max(setting.min, Math.round(value / setting.step) * setting.step));
      value = Number(value.toFixed(4));
      preferences[key] = value;
      var input = one('[data-reader-setting="' + key + '"]', reading);
      var output = one('[data-reader-output="' + key + '"]', reading);
      if (input) {
        input.value = String(value);
        input.style.setProperty('--reader-range-progress', ((value - setting.min) / (setting.max - setting.min) * 100) + '%');
      }
      if (output) output.textContent = setting.format(value);
      reading.style.setProperty(setting.css, setting.unit === 'px' ? value + 'px' : String(value));
      if (save) {
        try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch (error) {}
      }
    }

    Object.keys(settings).forEach(function (key) {
      applySetting(key, saved[key], false);
    });
    all('[data-reader-setting]', reading).forEach(function (input) {
      input.addEventListener('input', function () {
        applySetting(input.dataset.readerSetting, input.value, true);
      });
    });
    var settingsBox = one('.reader-settings', reading);
    if (settingsBox) settingsBox.open = window.matchMedia('(min-width: 1440px)').matches;
    all('[data-reader-reset]', reading).forEach(function (button) {
      button.addEventListener('click', function () {
        Object.keys(settings).forEach(function (key) { applySetting(key, settings[key].def, true); });
        say('已恢复默认');
        window.setTimeout(function () { say(''); }, 1600);
      });
    });
    all('[data-reader-action]', reading).forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.dataset.readerAction === 'print') {
          window.print();
          return;
        }
        var copyLink = function () {
          if (!navigator.clipboard) {
            say('这个环境不支持分享');
            return;
          }
          navigator.clipboard.writeText(window.location.href).then(function () {
            say('链接已复制');
          }, function () {
            say('复制失败');
          });
        };
        if (!navigator.share) {
          copyLink();
        } else {
          try {
            navigator.share({ title: document.title, url: window.location.href }).then(function () {
              say('已分享');
            }, copyLink);
          } catch (error) {
            copyLink();
          }
        }
        window.setTimeout(function () { say(''); }, 1600);
      });
    });

    buildToc();
    updateProgress();
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress, { passive: true });
  }

  function initHome() {
    var scene = one('[data-sr-scene]');
    var hero = one('[data-sr-hero]');
    if (!scene || !hero) return;
    document.documentElement.dataset.page = 'home';

    function updateRailState() {
      var scrolled = window.scrollY > Math.max(96, hero.offsetHeight * .42);
      shell.classList.toggle('is-scrolled', scrolled);
      document.documentElement.dataset.hero = scrolled ? 'scrolled' : 'top';
    }

    updateRailState();
    window.addEventListener('scroll', updateRailState, { passive: true });

    var image = one('[data-sr-image]', hero);
    var video = one('[data-sr-video]', hero);
    var stage = one('[data-sr-media-stage]', hero);
    var deck = one('[data-sr-deck]', hero);
    var choices = all('.sr-sheet', deck);
    var signature = one('[data-sr-signature]', hero);
    var title = one('[data-sr-title]', hero);
    var description = one('[data-sr-description]', hero);
    var reset = one('[data-sr-reset]', hero);
    var mediaToggle = one('[data-sr-media-toggle]', hero);
    var live = one('[data-sr-live]', scene);
    var grid = one('[data-sr-grid]', scene);
    var empty = one('[data-sr-empty]', scene);
    var filters = all('[data-sr-filter]', scene);
    var filterReset = one('[data-sr-filter-reset]', scene);

    var initial = {
      title: title ? title.textContent : '',
      description: description ? description.textContent : '',
      href: signature ? signature.getAttribute('href') : '#about'
    };
    var config = {
      type: hero.getAttribute('data-sr-hero-type') || 'image',
      video: hero.getAttribute('data-sr-video-src') || '',
      poster: hero.getAttribute('data-sr-poster') || '',
      mobileImage: hero.getAttribute('data-sr-mobile-image') || '',
      mobileVideo: hero.getAttribute('data-sr-mobile-video') || '',
      position: hero.getAttribute('data-sr-position') || '50% 50%',
      mobilePosition: hero.getAttribute('data-sr-mobile-position') || '50% 50%',
      tone: hero.getAttribute('data-sr-tone') || 'auto'
    };
    var initialImage = safeImage(image && image.getAttribute('src'), fallbackImage);
    var selected = -1;
    var restingFront = 0;
    var browsing = false;
    var revision = 0;
    var transitions = [];
    var videoPausedByUser = false;
    var videoFailed = false;
    var surfaceBlocked = false;
    var surfaceTimer = 0;
    var touchPointer = false;
    var identityAnimations = [];

    function setPosition() {
      hero.style.setProperty('--sr-media-position', mobile.matches ? config.mobilePosition : config.position);
    }

    function toneGround(rgb) {
      var brightness = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      var light = config.tone === 'light' || (config.tone !== 'dark' && brightness > 150);
      var scale = light ? 1 : Math.min(1, 36 / Math.max(1, brightness));
      var ground = rgb.map(function (channel) {
        return Math.round(light ? channel * .88 + 255 * .12 : Math.max(12, (channel * .65 + brightness * .35) * scale));
      });
      scene.style.setProperty('--sr-ground', 'rgb(' + ground.join(',') + ')');
      scene.dataset.surface = light ? 'light' : 'dark';
    }

    function fallbackTone() {
      toneGround(config.tone === 'light' ? [225, 232, 229] : [27, 31, 38]);
    }

    function sample(source) {
      if (!source || !stage) return null;
      var width = source.videoWidth || source.naturalWidth;
      var height = source.videoHeight || source.naturalHeight;
      if (!width || !height) return null;
      var ratio = stage.clientWidth / Math.max(1, stage.clientHeight);
      var cropWidth = Math.min(width, height * ratio);
      var cropHeight = Math.min(height, width / ratio);
      var position = (getComputedStyle(source).objectPosition || '50% 50%').match(/[\d.]+/g) || [50, 50];
      var left = (width - cropWidth) * Number(position[0]) / 100;
      var top = (height - cropHeight) * Number(position[1] || 50) / 100 + cropHeight * .78;
      var canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 8;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      try {
        context.drawImage(source, left, top, cropWidth, cropHeight * .22, 0, 0, 24, 8);
        var pixels = context.getImageData(0, 0, 24, 8).data;
        return [0, 1, 2].map(function (channel) {
          var sum = 0;
          for (var i = channel; i < pixels.length; i += 4) sum += pixels[i];
          return Math.round(sum / (pixels.length / 4));
        });
      } catch (error) {
        return null;
      }
    }

    function sampleImage() {
      var rgb = sample(image);
      if (rgb) toneGround(rgb);
      else fallbackTone();
    }

    function sampleVideo() {
      if (!video || config.type !== 'video' || videoFailed || surfaceBlocked || video.readyState < 2) return;
      var rgb = sample(video);
      if (rgb) toneGround(rgb);
      else surfaceBlocked = true;
    }

    function updateMediaToggle() {
      if (!video || config.type !== 'video' || !config.video || videoFailed) {
        if (mediaToggle) mediaToggle.hidden = true;
        return;
      }
      if (mediaToggle) {
        mediaToggle.hidden = false;
        var paused = video.paused;
        mediaToggle.setAttribute('aria-label', paused ? '播放视频' : '暂停视频');
        mediaToggle.title = paused ? '播放视频' : '暂停视频';
        mediaToggle.innerHTML = paused
          ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
      }
    }

    function playVideo() {
      if (!video || config.type !== 'video' || !config.video || videoFailed || videoPausedByUser || reduced.matches || document.hidden) return;
      var attempt = video.play();
      if (attempt && attempt.catch) attempt.catch(function () { updateMediaToggle(); });
    }

    function pauseVideo() {
      if (!video) return;
      try { video.pause(); } catch (error) {}
      updateMediaToggle();
    }

    function setupVideo() {
      hero.dataset.media = config.type;
      if (!video || config.type !== 'video' || !config.video) {
        if (video) video.hidden = true;
        updateMediaToggle();
        return;
      }
      var source = mobile.matches ? config.mobileVideo || config.video : config.video;
      var poster = config.poster || config.mobileImage || initialImage;
      video.hidden = false;
      video.poster = safeImage(poster, initialImage);
      if (video.getAttribute('src') !== source) video.setAttribute('src', source);
      video.load();
      playVideo();
    }

    function setMobileImage() {
      if (!image || selected >= 0) return;
      var source = mobile.matches ? config.mobileImage || initialImage : initialImage;
      if (image.getAttribute('src') !== source) {
        image.src = source;
        image.decode().then(sampleImage).catch(function () {});
      }
    }

    function paintDeck() {
      if (!choices.length) return;
      var front = selected < 0 ? 0 : selected;
      if (!browsing) restingFront = front;
      var order = choices.map(function (_, index) { return (restingFront + index) % choices.length; });
      choices.forEach(function (button, index) {
        button.dataset.depth = String(order.indexOf(index));
        button.setAttribute('aria-pressed', String(index === selected));
        button.setAttribute('aria-label', (index === selected ? '当前文章：' : '选择文章：') + (button.getAttribute('data-title') || ''));
      });
      if (reset) reset.hidden = selected < 0;
    }

    function clearTransitions() {
      transitions.forEach(function (animation) { try { animation.cancel(); } catch (error) {} });
      transitions = [];
      if (stage) all('.sr-media-transition', stage).forEach(function (layer) { layer.remove(); });
    }

    function fadeLayer(layer, frames, duration) {
      if (reduced.matches) {
        layer.style.opacity = '1';
        return Promise.resolve();
      }
      var animation = layer.animate(frames, { duration: duration, easing: ease, fill: 'forwards' });
      transitions.push(animation);
      return animation.finished.catch(function () {}).then(function () {
        var index = transitions.indexOf(animation);
        if (index >= 0) transitions.splice(index, 1);
      });
    }

    function applyIdentity(index) {
      var item = index < 0 ? null : choices[index];
      if (!title || !description || !signature) return;
      title.textContent = item ? item.getAttribute('data-title') : initial.title;
      description.textContent = item ? item.getAttribute('data-description') : initial.description;
      signature.setAttribute('href', item ? item.getAttribute('data-url') : initial.href);
      if (index < 0) delete hero.dataset.selected;
      else hero.dataset.selected = 'true';
    }

    function clearIdentityAnimations() {
      identityAnimations.forEach(function (animation) {
        try { animation.cancel(); } catch (error) {}
      });
      identityAnimations = [];
      if (signature) signature.style.animation = '';
      if (description) description.style.animation = '';
    }

    function transitionIdentity(index, current) {
      if (!signature || !description || reduced.matches) {
        applyIdentity(index);
        return Promise.resolve();
      }
      clearIdentityAnimations();
      var elements = [signature, description];
      var outgoing = elements.map(function (element) {
        var style = getComputedStyle(element);
        var animation = element.animate([
          { opacity: style.opacity, transform: style.transform },
          { opacity: 0, transform: 'translateY(-8px)' }
        ], { duration: 80, easing: ease, fill: 'forwards' });
        identityAnimations.push(animation);
        return animation.finished.catch(function () {});
      });
      return Promise.all(outgoing).then(function () {
        if (current !== revision) return;
        applyIdentity(index);
        var incoming = elements.map(function (element, offset) {
          var animation = element.animate([
            { opacity: 0, transform: 'translateY(12px)' },
            { opacity: 1, transform: 'translateY(0)' }
          ], { duration: 180, delay: offset * 20, easing: ease, fill: 'forwards' });
          identityAnimations.push(animation);
          return animation.finished.catch(function () {});
        });
        return Promise.all(incoming).then(function () {
          if (current !== revision) return;
          elements.forEach(function (element) {
            element.style.opacity = '';
            element.style.transform = '';
          });
          clearIdentityAnimations();
        });
      });
    }

    async function select(index) {
      if (!choices[index] || index === selected) return;
      var current = ++revision;
      clearTransitions();
      var source = safeImage(choices[index].getAttribute('data-cover'), fallbackImage);
      hero.dataset.media = 'image';
      var layer = new Image();
      layer.alt = '';
      layer.className = 'sr-media-transition';
      layer.src = source;
      try {
        await layer.decode();
      } catch (error) {
        applyIdentity(index);
        return;
      }
      if (current !== revision || !stage) return;
      stage.appendChild(layer);
      var rgb = sample(layer);
      if (rgb) toneGround(rgb);
      var identityTransition = transitionIdentity(index, current);
      await Promise.all([
        fadeLayer(layer, [{ opacity: 0, transform: 'scale(1.025)' }, { opacity: 1, transform: 'scale(1)' }], 280),
        identityTransition
      ]);
      if (current !== revision) return;
      if (image) {
        image.src = source;
        image.decode().then(function () { if (current === revision) sampleImage(); }).catch(function () {});
      }
      selected = index;
      browsing = false;
      deck.removeAttribute('data-expanded');
      paintDeck();
      pauseVideo();
      clearTransitions();
      if (live) live.textContent = '已选择：' + (choices[index].getAttribute('data-title') || '');
    }

    async function restore() {
      if (selected < 0) return;
      var current = ++revision;
      hero.dataset.media = config.type;
      clearTransitions();
      var layer = new Image();
      layer.alt = '';
      layer.className = 'sr-media-transition';
      layer.src = image ? image.getAttribute('src') : fallbackImage;
      try { await layer.decode(); } catch (error) {}
      if (current !== revision) return;
      if (stage) stage.appendChild(layer);
      selected = -1;
      browsing = false;
      deck.removeAttribute('data-expanded');
      paintDeck();
      applyIdentity(-1);
      if (image) {
        image.src = initialImage;
        image.decode().then(function () { if (current === revision) sampleImage(); }).catch(function () {});
      }
      if (config.type === 'video') {
        videoPausedByUser = false;
        playVideo();
      }
      if (!reduced.matches) await fadeLayer(layer, [{ opacity: 1 }, { opacity: 0 }], 280);
      clearTransitions();
      if (live) live.textContent = '已恢复默认影像';
    }

    function bindDeck() {
      if (!deck || !choices.length) return;
      deck.addEventListener('pointerdown', function (event) {
        touchPointer = event.pointerType === 'touch';
      });
      deck.addEventListener('pointerenter', function (event) {
        if (event.pointerType === 'touch') return;
        browsing = true;
        deck.dataset.expanded = '';
        paintDeck();
      });
      deck.addEventListener('pointerleave', function (event) {
        if (event.pointerType === 'touch') return;
        browsing = false;
        deck.removeAttribute('data-expanded');
        paintDeck();
      });
      choices.forEach(function (button, index) {
        button.addEventListener('click', function () {
          if (touchPointer && !deck.hasAttribute('data-expanded')) {
            browsing = true;
            deck.dataset.expanded = '';
            paintDeck();
            return;
          }
          if (touchPointer) {
            browsing = false;
            deck.removeAttribute('data-expanded');
          }
          select(index);
        });
        button.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(index);
            return;
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            var step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
            choices[(index + step + choices.length) % choices.length].focus();
          }
        });
      });
      deck.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        browsing = false;
        deck.removeAttribute('data-expanded');
        paintDeck();
      });
    }

    function bindFilters() {
      if (!grid) return;
      var cards = all('.sr-post-card', grid);
      filters.forEach(function (button) {
        button.addEventListener('click', function () {
          var filter = button.getAttribute('data-sr-filter') || '';
          filters.forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); });
          cards.forEach(function (card) {
            card.hidden = Boolean(filter && card.getAttribute('data-category') !== filter);
          });
          var visible = cards.filter(function (card) { return !card.hidden; }).length;
          if (empty) empty.hidden = visible !== 0;
          if (filterReset) filterReset.hidden = !filter;
          if (live) live.textContent = '显示 ' + visible + ' 篇文章';
        });
      });
      if (filterReset) filterReset.addEventListener('click', function () {
        filters.forEach(function (item) { item.setAttribute('aria-pressed', String(!item.getAttribute('data-sr-filter'))); });
        cards.forEach(function (card) { card.hidden = false; });
        if (empty) empty.hidden = true;
        filterReset.hidden = true;
        if (live) live.textContent = '显示全部文章';
      });
    }

    setPosition();
    fallbackTone();
    paintDeck();
    bindDeck();
    bindFilters();
    addImageFallback(image, fallbackImage);
    all('.sr-post-card__cover', scene).forEach(function (cover) { addImageFallback(cover, fallbackImage); });

    if (image) {
      if (image.complete) sampleImage();
      image.addEventListener('load', function () { if (selected < 0) sampleImage(); });
    }
    if (video) {
      video.addEventListener('loadeddata', function () { sampleVideo(); updateMediaToggle(); });
      video.addEventListener('playing', function () { sampleVideo(); updateMediaToggle(); });
      video.addEventListener('error', function () {
        videoFailed = true;
        video.hidden = true;
        hero.dataset.videoFailed = 'true';
        fallbackTone();
        updateMediaToggle();
      });
    }
    setupVideo();
    updateMediaToggle();
    if (mediaToggle) mediaToggle.addEventListener('click', function () {
      if (!video) return;
      if (video.paused) {
        videoPausedByUser = false;
        playVideo();
      } else {
        videoPausedByUser = true;
        pauseVideo();
      }
      updateMediaToggle();
    });
    if (reset) reset.addEventListener('click', restore);

    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        if (entries[0] && entries[0].isIntersecting) playVideo();
        else pauseVideo();
      }, { threshold: .08 }).observe(hero);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pauseVideo();
      else playVideo();
    });
    window.addEventListener('resize', function () {
      setPosition();
      setMobileImage();
    });
    surfaceTimer = window.setInterval(function () {
      if (!document.hidden && video && !video.paused) sampleVideo();
    }, 1800);
    window.addEventListener('pagehide', function () {
      clearInterval(surfaceTimer);
      pauseVideo();
    });
  }

  initNavigation();
  initSidebar();
  initComments();
  initHome();
  initReader();
})();
