/**
 * Expense & Budget Visualizer — app.js
 *
 * Single vanilla-JS file. No frameworks, no build tools.
 *
 * Modules (all inside one IIFE to avoid polluting global scope):
 *   Utils            — pure helper functions
 *   Validator        — form validation
 *   Storage          — localStorage read/write with error handling
 *   Store            — in-memory transaction list + mutations
 *   Renderer         — all DOM updates and Chart.js management
 *   FormController   — form submit + live error clearing
 *   App              — bootstrap
 */

(function () {
  'use strict';

  /* ============================================================
     CONSTANTS
     ============================================================ */
  var STORAGE_KEY = 'ebv_v1_transactions';

  var CATEGORIES = ['Food', 'Transport', 'Fun'];

  var CAT_ICONS  = { Food: '🍔', Transport: '🚗', Fun: '🎉' };
  var CAT_COLORS = { Food: '#f97316', Transport: '#3b82f6', Fun: '#a855f7' };

  /* ============================================================
     UTILS
     ============================================================ */

  /**
   * Format a number as USD currency string.
   * Falls back to manual formatting if Intl is unavailable.
   */
  function fmtMoney(n) {
    var num = (typeof n === 'number' && isFinite(n)) ? n : 0;
    try {
      return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    } catch (_) {
      var fixed  = num.toFixed(2);
      var parts  = fixed.split('.');
      parts[0]   = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return '$' + parts[0] + '.' + parts[1];
    }
  }

  /** Return today as YYYY-MM-DD. */
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Format YYYY-MM-DD to a readable string, e.g. "May 26, 2026". */
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    try {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }
  }

  /** Escape HTML special characters to prevent XSS. */
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Generate a unique ID: timestamp-base36 + random suffix. */
  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /* ============================================================
     VALIDATOR
     ============================================================ */
  var Validator = {
    /**
     * @param {{ name: string, amount: string, category: string }} d
     * @returns {{ ok: boolean, errors: { name?: string, amount?: string, category?: string } }}
     */
    check: function (d) {
      var e = {};

      var name = (d.name || '').trim();
      if (!name)           e.name = 'Item name is required.';
      else if (name.length > 100) e.name = 'Item name must be 100 characters or less.';

      var raw = (d.amount || '').toString().trim();
      if (!raw) {
        e.amount = 'Amount is required.';
      } else {
        var n = parseFloat(raw);
        if (isNaN(n))       e.amount = 'Amount must be a valid number.';
        else if (n < 0.01)  e.amount = 'Amount must be at least $0.01.';
        else if (n > 999999999.99) e.amount = 'Amount is too large.';
      }

      var cat = (d.category || '').trim();
      if (!cat)                          e.category = 'Please select a category.';
      else if (CATEGORIES.indexOf(cat) < 0) e.category = 'Invalid category.';

      return { ok: Object.keys(e).length === 0, errors: e };
    }
  };

  /* ============================================================
     STORAGE  (localStorage wrapper)
     ============================================================ */
  var Storage = {
    _ok: null,

    /** Returns true if localStorage is accessible. */
    available: function () {
      if (this._ok !== null) return this._ok;
      try {
        localStorage.setItem('__ebv_ping__', '1');
        localStorage.removeItem('__ebv_ping__');
        this._ok = true;
      } catch (_) { this._ok = false; }
      return this._ok;
    },

    /**
     * Load saved transactions.
     * @returns {{ list: Array, corrupt: boolean, unavailable: boolean }}
     */
    load: function () {
      if (!this.available()) return { list: [], corrupt: false, unavailable: true };
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null)     return { list: [], corrupt: false, unavailable: false };
      try {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('not array');
        return { list: parsed, corrupt: false, unavailable: false };
      } catch (_) {
        return { list: [], corrupt: true, unavailable: false };
      }
    },

    /** Persist the current list. */
    save: function (list) {
      if (!this.available()) return;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) {}
    }
  };

  /* ============================================================
     STORE  (in-memory state + mutations)
     ============================================================ */
  var Store = (function () {
    var _list = [];   // newest first

    return {
      all: function ()  { return _list.slice(); },
      set: function (l) { _list = Array.isArray(l) ? l.slice() : []; },

      /** Add a validated transaction and persist. */
      add: function (formData) {
        _list.unshift({
          id:       uid(),
          name:     formData.name.trim(),
          amount:   parseFloat(formData.amount),
          category: formData.category,
          date:     todayISO()
        });
        Storage.save(_list);
        Renderer.refresh(_list);
      },

      /** Remove a transaction by id and persist. */
      remove: function (id) {
        _list = _list.filter(function (t) { return t.id !== id; });
        Storage.save(_list);
        Renderer.refresh(_list);
      },

      total: function () {
        return _list.reduce(function (s, t) { return s + t.amount; }, 0);
      },

      byCategory: function () {
        var out = { Food: 0, Transport: 0, Fun: 0 };
        _list.forEach(function (t) {
          if (out[t.category] !== undefined) out[t.category] += t.amount;
        });
        return out;
      }
    };
  })();

  /* ============================================================
     RENDERER  (all DOM + Chart.js)
     ============================================================ */
  var Renderer = (function () {
    var _chart = null;   // Chart.js instance

    /* ── helpers ── */
    function el(id) { return document.getElementById(id); }

    function show(elem) { if (elem) elem.style.display = ''; }
    function hide(elem) { if (elem) elem.style.display = 'none'; }

    /* ── public API ── */
    return {

      /** Full re-render triggered after every mutation. */
      refresh: function (list) {
        this.balance(list.reduce(function (s, t) { return s + t.amount; }, 0));
        this.list(list);
        this.chart(Store.byCategory());
      },

      /** Update the balance display. */
      balance: function (total) {
        var e = el('balance-amount');
        if (e) e.textContent = fmtMoney(total);
      },

      /** Render the scrollable transaction list. */
      list: function (list) {
        var container = el('tx-list');
        if (!container) return;

        // Remove old items (leave the empty-msg element in place)
        var old = container.querySelectorAll('.tx-item');
        for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);

        var emptyMsg = el('list-empty');

        if (list.length === 0) {
          show(emptyMsg);
          return;
        }
        hide(emptyMsg);

        var frag = document.createDocumentFragment();
        list.forEach(function (t) { frag.appendChild(Renderer._item(t)); });
        container.appendChild(frag);
      },

      /** Build one transaction item element. */
      _item: function (t) {
        var div = document.createElement('div');
        div.className = 'tx-item';
        div.setAttribute('role', 'listitem');
        div.setAttribute('data-id', t.id);

        var icon = CAT_ICONS[t.category] || '💸';
        var cls  = CATEGORIES.indexOf(t.category) >= 0 ? t.category : '';

        div.innerHTML =
          '<div class="tx-badge ' + cls + '" aria-hidden="true">' + icon + '</div>' +
          '<div class="tx-info">' +
            '<div class="tx-name" title="' + esc(t.name) + '">' + esc(t.name) + '</div>' +
            '<div class="tx-meta">' + esc(t.category) + ' &bull; ' + fmtDate(t.date) + '</div>' +
          '</div>' +
          '<div class="tx-amount">' + fmtMoney(t.amount) + '</div>' +
          '<button class="btn-del" data-id="' + esc(t.id) + '" ' +
            'aria-label="Delete ' + esc(t.name) + '" title="Delete">&#x2715;</button>';

        return div;
      },

      /** Render / update the pie chart. */
      chart: function (cats) {
        var canvas   = el('expense-chart');
        var emptyMsg = el('chart-empty');

        var total = cats.Food + cats.Transport + cats.Fun;

        if (total === 0) {
          hide(canvas);
          if (emptyMsg) { emptyMsg.textContent = 'No data to display yet.'; show(emptyMsg); }
          if (_chart) { _chart.destroy(); _chart = null; }
          return;
        }

        if (typeof Chart === 'undefined') {
          hide(canvas);
          if (emptyMsg) { emptyMsg.textContent = 'Chart unavailable — check your internet connection.'; show(emptyMsg); }
          return;
        }

        show(canvas);
        hide(emptyMsg);

        // Build arrays — skip zero-value categories
        var labels = [], data = [], colors = [];
        CATEGORIES.forEach(function (c) {
          if (cats[c] > 0) {
            var pct = Math.round((cats[c] / total) * 100);
            labels.push(CAT_ICONS[c] + ' ' + c + ' (' + pct + '%)');
            data.push(cats[c]);
            colors.push(CAT_COLORS[c]);
          }
        });

        if (_chart) {
          _chart.data.labels                      = labels;
          _chart.data.datasets[0].data            = data;
          _chart.data.datasets[0].backgroundColor = colors;
          _chart.update();
        } else {
          _chart = new Chart(canvas, {
            type: 'pie',
            data: {
              labels: labels,
              datasets: [{
                data: data,
                backgroundColor: colors,
                borderColor: '#ffffff',
                borderWidth: 3,
                hoverOffset: 8
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: {
                  position: 'bottom',
                  labels: {
                    font: { size: 13, family: "'Segoe UI', system-ui, sans-serif" },
                    padding: 16,
                    usePointStyle: true,
                    pointStyleWidth: 10
                  }
                },
                tooltip: {
                  callbacks: {
                    label: function (ctx) { return ' ' + fmtMoney(ctx.parsed); }
                  }
                }
              }
            }
          });
        }
      },

      /** Show inline field errors. */
      errors: function (errs) {
        var map = {
          name:     { inp: 'f-name',     err: 'f-name-err'     },
          amount:   { inp: 'f-amount',   err: 'f-amount-err'   },
          category: { inp: 'f-category', err: 'f-category-err' }
        };
        Object.keys(map).forEach(function (k) {
          var inp = el(map[k].inp);
          var err = el(map[k].err);
          if (errs[k]) {
            if (err) err.textContent = errs[k];
            if (inp) inp.classList.add('invalid');
          } else {
            if (err) err.textContent = '';
            if (inp) inp.classList.remove('invalid');
          }
        });
      },

      /** Clear all field errors. */
      clearErrors: function () { this.errors({}); },

      /** Reset the form to its blank state. */
      resetForm: function () {
        var f = el('tx-form');
        if (f) f.reset();
        this.clearErrors();
      },

      /** Show the top notification banner. */
      banner: function (msg, isError) {
        var b = el('app-banner');
        if (!b) return;
        b.textContent = msg;
        b.classList.remove('hidden', 'is-error');
        if (isError) b.classList.add('is-error');
      }
    };
  })();

  /* ============================================================
     FORM CONTROLLER
     ============================================================ */
  var FormController = {
    init: function () {
      var form = document.getElementById('tx-form');
      if (!form) return;

      /* Submit */
      form.addEventListener('submit', function (e) {
        e.preventDefault();

        var data = {
          name:     (document.getElementById('f-name')     || {}).value || '',
          amount:   (document.getElementById('f-amount')   || {}).value || '',
          category: (document.getElementById('f-category') || {}).value || ''
        };

        var result = Validator.check(data);
        if (!result.ok) {
          Renderer.errors(result.errors);
          // Focus first invalid field
          if (result.errors.name)          document.getElementById('f-name').focus();
          else if (result.errors.amount)   document.getElementById('f-amount').focus();
          else if (result.errors.category) document.getElementById('f-category').focus();
          return;
        }

        Renderer.clearErrors();
        Store.add(data);
        Renderer.resetForm();
        document.getElementById('f-name').focus();
      });

      /* Live error clearing — one handler per field */
      var fieldMap = [
        { id: 'f-name',     errId: 'f-name-err'     },
        { id: 'f-amount',   errId: 'f-amount-err'   },
        { id: 'f-category', errId: 'f-category-err' }
      ];
      fieldMap.forEach(function (f) {
        var inp = document.getElementById(f.id);
        var err = document.getElementById(f.errId);
        if (!inp) return;
        function clear() {
          inp.classList.remove('invalid');
          if (err) err.textContent = '';
        }
        inp.addEventListener('input',  clear);
        inp.addEventListener('change', clear);
      });
    }
  };

  /* ============================================================
     DELETE  (event delegation on the list section)
     ============================================================ */
  function initDelete() {
    var section = document.getElementById('tx-list');
    if (!section) return;

    section.addEventListener('click', function (e) {
      // Walk up from click target to find .btn-del
      var node = e.target;
      while (node && node !== section) {
        if (node.className && node.className.indexOf('btn-del') >= 0) {
          var id = node.getAttribute('data-id');
          if (id) Store.remove(id);
          return;
        }
        node = node.parentNode;
      }
    });
  }

  /* ============================================================
     APP BOOTSTRAP
     ============================================================ */
  function boot() {
    var result = Storage.load();

    if (result.unavailable) {
      Renderer.banner('Local storage is unavailable. Data will not be saved between sessions.', true);
    } else if (result.corrupt) {
      Renderer.banner('Previous data could not be loaded and has been reset.', true);
    }

    Store.set(result.list);
    Renderer.refresh(Store.all());
    FormController.init();
    initDelete();
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
