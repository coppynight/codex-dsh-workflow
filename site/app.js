/* ==========================================================================
   codex-dsh-workflow — 页面脚本（原生 JS，无依赖）
   - 证据区：读取 ./data/summary.json，缺失/null 一律显示「待实测」
   - 安装命令复制按钮、仓库/示例/方法学链接注入
   - 无数据时不填零、不编造；fetch 失败给出明确提示
   纯逻辑部分（buildModel 及以下）可在 Node 中 require 自测：
   浏览器环境自动挂到 window.DSHPage。
   ========================================================================== */
(function () {
  'use strict';

  var DATA_URL = './data/summary.json';

  /* ------------------------------------------------------------------ *
   * 纯函数（可在 Node 中测试；不触碰 DOM）
   * ------------------------------------------------------------------ */

  var WAIT = '待实测';

  /** null / undefined / 空串 一律视为“未提供”。 */
  function isNullish(v) {
    return v === null || v === undefined || v === '';
  }

  /** 数字或数字字符串 → number；否则 null。不做“假想零值”。 */
  function toNum(v) {
    if (isNullish(v)) return null;
    var n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtInt(n) {
    return new Intl.NumberFormat('zh-CN').format(n);
  }

  /** 有效数字 → 千分位字符串；否则 null。 */
  function fmtNumOrNull(v) {
    var n = toNum(v);
    return n === null ? null : fmtInt(n);
  }

  /** 展示用：null → 「待实测」；数字原样（含 0，0 也是真实测量值）。 */
  function fmtOrWait(v) {
    var s = fmtNumOrNull(v);
    return s === null ? WAIT : s;
  }

  /**
   * astraReductionPct 归一化：
   * 仓库侧可能给百分数（55）或小数（0.55），统一转成百分数值；null → null。
   */
  function pctValue(v) {
    var n = toNum(v);
    if (n === null) return null;
    return n; // Schema unit is percentage points: 0.5 means 0.5%, never 50%.
  }

  function fmtPctOrWait(v) {
    var p = pctValue(v);
    if (p === null) return WAIT;
    var rounded = Math.round(p * 10) / 10;
    return '约 ' + String(rounded) + '%';
  }

  function fmtDateOrWait(v) {
    if (isNullish(v)) return WAIT;
    var d = new Date(v);
    if (Number.isNaN(d.getTime())) return WAIT;
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  }

  /**
   * 状态文案：常见值映射为中文；未收录的值原样透传（不猜、不编）。
   * null → null（由调用处统一转「待实测」）。
   */
  var STATUS_LABELS = {
    measuring: '测量中',
    done: '已完成',
    complete: '已完成',
    paused: '已暂停',
    planned: '计划中',
    started: '进行中'
  };
  function statusText(v) {
    if (isNullish(v)) return null;
    var key = String(v);
    return Object.prototype.hasOwnProperty.call(STATUS_LABELS, key) ? STATUS_LABELS[key] : key;
  }

  /** 回归：fixed / total，两者都缺时才是「待实测」。 */
  function ratioText(fixed, total) {
    var f = toNum(fixed);
    var t = toNum(total);
    if (f === null || t === null) return null;
    return fmtInt(f) + ' / ' + fmtInt(t);
  }

  function trimStr(v) {
    if (isNullish(v)) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /**
   * 把 summary.json 原始对象归一化为展示模型。
   * 规则：任何 null/缺失 → 「待实测」或 null；绝不把缺测变成 0。
   */
  function buildModel(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    var t = raw.token && typeof raw.token === 'object' ? raw.token : {};
    var dl = raw.delivery && typeof raw.delivery === 'object' ? raw.delivery : {};
    var linksRaw = raw.links && typeof raw.links === 'object' ? raw.links : {};
    var casesRaw = Array.isArray(raw.cases) ? raw.cases : [];

    var baseN = toNum(t.baselineAstraTokens);
    var workN = toNum(t.workflowAstraTokens);

    function normCase(c) {
      var bN = toNum(c.baseline);
      var wN = toNum(c.workflow);
      return {
        idText: trimStr(c.id) || '',
        titleText: trimStr(c.title) || '（无标题）',
        kindText: trimStr(c.kind) || '',
        statusText: statusText(c.status) === null ? WAIT : statusText(c.status),
        summaryText: trimStr(c.summary),
        baselineText: fmtOrWait(c.baseline),
        workflowText: fmtOrWait(c.workflow),
        hasBars: bN !== null && wN !== null && Math.max(bN, wN) > 0,
        baseN: bN,
        workN: wN,
        evidenceUrl: trimStr(c.evidenceUrl)
      };
    }

    return {
      updatedAtText: fmtDateOrWait(raw.updatedAt),
      token: {
        statusText: statusText(t.status) === null ? WAIT : statusText(t.status),
        baselineText: fmtOrWait(t.baselineAstraTokens),
        workflowText: fmtOrWait(t.workflowAstraTokens),
        pctText: fmtPctOrWait(t.astraReductionPct),
        caseCountText: fmtOrWait(t.caseCount),
        hasBars: baseN !== null && workN !== null && Math.max(baseN, workN) > 0,
        baseN: baseN,
        workN: workN,
        notes: trimStr(t.notes)
      },
      delivery: {
        ratioText: ratioText(dl.regressionsFixed, dl.regressionsTotal) === null
          ? WAIT : ratioText(dl.regressionsFixed, dl.regressionsTotal),
        notes: trimStr(dl.notes)
      },
      cases: casesRaw.filter(function (c) { return c && typeof c === 'object'; }).map(normCase),
      links: {
        repo: trimStr(linksRaw.repo),
        examples: trimStr(linksRaw.examples),
        methodology: trimStr(linksRaw.methodology)
      }
    };
  }

  /** 链接白名单：http(s) 或站内相对/锚点；丢弃 javascript: 等危险协议。 */
  function safeUrl(v) {
    if (isNullish(v)) return null;
    var u = String(v).trim();
    if (/^https?:/i.test(u)) return u;
    if (/^\.{0,2}\//.test(u) || /^#/.test(u)) return u;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 浏览器部分
   * ------------------------------------------------------------------ */

  var CORE = {
    WAIT: WAIT,
    isNullish: isNullish,
    toNum: toNum,
    fmtInt: fmtInt,
    fmtNumOrNull: fmtNumOrNull,
    fmtOrWait: fmtOrWait,
    pctValue: pctValue,
    fmtPctOrWait: fmtPctOrWait,
    fmtDateOrWait: fmtDateOrWait,
    statusText: statusText,
    ratioText: ratioText,
    buildModel: buildModel,
    safeUrl: safeUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CORE;
    return; // Node 自测模式：不再触碰 DOM
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  /** 便捷建元素：h('p',{class:'x',text:'…'}, child…) */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined) return;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return n;
  }

  function liveRegion(id) { return document.getElementById(id); }
  function announce(id, msg) {
    var el = liveRegion(id);
    if (el) el.textContent = msg;
  }

  /* ---------- 证据区 ---------- */

  function pairRow(label, valueText) {
    var valueEl = /待实测/.test(valueText)
      ? h('span', { class: 'wait', text: valueText })
      : h('b', { text: valueText });
    return h('div', { class: 'pair-stat' }, [
      h('span', { text: label }),
      valueEl
    ]);
  }

  function barsEl(baseV, workV, baseLabel, workLabel) {
    var max = Math.max(baseV, workV);
    if (!(max > 0)) return null;
    function fillRow(cls, label, v) {
      var pct = Math.max(2, (v / max) * 100);
      var fill = h('div', { class: 'bar-fill' });
      fill.style.width = pct + '%';
      var track = h('div', { class: 'bar-track', 'aria-hidden': 'true' }, [fill]);
      return h('div', { class: 'bar-row ' + cls }, [
        h('div', { class: 'bar-top' }, [
          h('span', { text: label }),
          h('b', { text: CORE.fmtInt(v) })
        ]),
        track
      ]);
    }
    return h('div', { class: 'bars' }, [
      fillRow('bar-base', baseLabel, baseV),
      fillRow('bar-flow', workLabel, workV),
      h('p', { class: 'bar-legend' }, [
        h('span', { class: 'sw sw-base', 'aria-hidden': 'true' }),
        '基线 · Astra 直接生成　',
        h('span', { class: 'sw sw-flow', 'aria-hidden': 'true' }),
        '工作流 · 委托 DSH 后'
      ])
    ]);
  }

  function evMetaLink(label, url, dataKey) {
    var safe = safeUrl(url);
    if (!safe) return null;
    var a = h('a', {
      href: safe,
      text: label,
      'data-link': dataKey
    });
    if (/^https?:/i.test(safe)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  }

  function renderEvidence(root, m) {
    var frag = document.createDocumentFragment();

    /* 元信息行 */
    var metaLinks = [];
    var ex = evMetaLink('示例', m.links.examples, 'examples');
    var meth = evMetaLink('测量方法学', m.links.methodology, 'methodology');
    if (ex) metaLinks.push(ex);
    if (meth) metaLinks.push(meth);

    var metaRow = h('div', { class: 'ev-meta-row' }, [
      h('span', { class: 'ev-date' }, ['数据更新：', m.updatedAtText]),
      h('span', { class: 'pill lime', text: '小样本配对 · 仅统计 Astra 单侧' })
    ]);
    if (metaLinks.length) {
      metaRow.appendChild(h('span', { class: 'ev-meta-links' }, metaLinks));
    }
    frag.appendChild(metaRow);

    /* 两张卡片 */
    var tokenChipCls = m.token.statusText === WAIT ? 'pill wait' : 'pill';
    var tokenHead = h('div', { class: 'ev-card-head' }, [
      h('h3', { text: '受控子会话 · Astra token' }),
      h('span', { class: tokenChipCls, text: m.token.statusText })
    ]);
    var tokenKids = [
      tokenHead,
      h('p', { class: 'ev-sub', text: '配对 case 数：' + m.token.caseCountText + '。相同需求分别由 Astra 直接生成，或 DSH 实现后由 Astra 审查。统一程序验收。' }),
      pairRow('基线 · Astra 直接生成', m.token.baselineText),
      pairRow('工作流 · 委托 DSH 后', m.token.workflowText),
      pairRow('下降比例（负值表示增加）', m.token.pctText)
    ];
    if (m.token.hasBars) {
      tokenKids.push(barsEl(m.token.baseN, m.token.workN, '基线 tokens', '工作流 tokens'));
    }
    if (m.token.notes) {
      tokenKids.push(h('p', { class: 'ev-notes', text: m.token.notes }));
    }
    var delivHead = h('div', { class: 'ev-card-head' }, [
      h('h3', { text: '交付质量 · 回归' })
    ]);
    var isWait = m.delivery.ratioText === WAIT;
    var bigStat = isWait
      ? h('div', { class: 'big-stat', text: WAIT })
      : h('div', { class: 'big-stat', text: m.delivery.ratioText });
    var delivKids = [
      delivHead,
      bigStat,
      h('p', { class: 'big-stat-sub', text: '故障重建被测试捕获，修复后同一测试通过。本机离线夹具回放，不代表通用交付率。' })
    ];
    if (m.delivery.notes) {
      delivKids.push(h('p', { class: 'ev-notes', text: m.delivery.notes }));
    }
    var cardGrid = h('div', { class: 'ev-card-grid' }, [
      h('article', { class: 'ev-card' }, tokenKids),
      h('article', { class: 'ev-card' }, delivKids)
    ]);
    frag.appendChild(cardGrid);

    /* 分 case 明细 */
    frag.appendChild(h('h3', { class: 'cases-h', text: '分 case 明细' }));
    if (!m.cases.length) {
      frag.appendChild(h('p', { class: 'note-block', text: 'cases 为空或尚未发布 —— 全部显示「待实测」。' }));
    } else {
      var list = h('div', { class: 'case-list' });
      m.cases.forEach(function (c, i) {
        var summaryKids = [];
        if (c.kindText) {
          summaryKids.push(h('span', { class: 'pill case-kind', text: c.kindText }));
        }
        summaryKids.push(h('span', { class: 'case-summary-title', text: c.titleText }));
        if (c.idText) summaryKids.push(h('span', { class: 'case-id', text: c.idText }));
        var caseChipCls = c.statusText === WAIT ? 'pill wait' : 'pill';
        summaryKids.push(h('span', { class: caseChipCls, text: c.statusText }));
        summaryKids.push(h('span', { class: 'case-toggle', 'aria-hidden': 'true', text: '详情 ▾' }));

        var summ = h('summary', null, summaryKids);
        summ.setAttribute('aria-expanded', 'false');
        summ.id = 'case-summary-' + i;

        var bodyKids = [];
        if (c.summaryText) bodyKids.push(h('p', { text: c.summaryText }));
        if (c.baseN !== null || c.workN !== null) {
          bodyKids.push(pairRow('基线 · Astra tokens（配对样本）', c.baselineText));
          bodyKids.push(pairRow('工作流 · Astra tokens（配对样本）', c.workflowText));
          if (c.hasBars) {
            bodyKids.push(barsEl(c.baseN, c.workN, '基线 tokens', '工作流 tokens'));
          }
        }
        var evA = evMetaLink('证据链接 ↗', c.evidenceUrl, 'case-evidence');
        if (evA) {
          bodyKids.push(h('p', { class: 'case-links' }, [evA]));
        }

        var det = h('details', { class: 'case-item', 'data-case': String(i) }, [
          summ,
          h('div', { class: 'case-body' }, bodyKids)
        ]);
        det.addEventListener('toggle', function () {
          summ.setAttribute('aria-expanded', String(det.open));
        });
        list.appendChild(det);
      });
      frag.appendChild(list);
    }

    /* 口径边界 —— 独立于卡片，始终展示 */
    frag.appendChild(h('aside', { class: 'caveat' }, [
      h('p', { class: 'caveat-title' }, [h('span', { 'aria-hidden': 'true', text: '⊘' }), '总 token 的口径边界（单算）']),
      h('p', { text: '用量范围：固定需求后的 Astra 子会话，input（含 cached 部分）+ output；不含主会话、页面制作和 DSH。DSH 的独立用量见案例记录，缓存计数口径与 Astra 不同。两例单次测试不代表一般规律，也不证明总费用或完整端到端交付率提升。' })
    ]));

    root.textContent = '';
    root.appendChild(frag);
  }

  function renderEvidenceFail(root, reason) {
    root.textContent = '';
    var frag = document.createDocumentFragment();
    frag.appendChild(h('div', { class: 'ev-fail' }, [
      h('h3', { text: '数据暂未就绪' }),
      h('p', { text: '未能读取 ./data/summary.json（' + reason + '）。在仓库发布真实数据之前，本区保持「待实测」——不填零、不编结果、不展示示例值。' }),
      h('p', { class: 'note-block', text: '文件就位后自动生效：部署到 GitHub Pages 的 /codex-dsh-workflow/ 子路径，或用任意静态服务器托管本目录后访问即可。' })
    ]));
    frag.appendChild(h('aside', { class: 'caveat' }, [
      h('p', { class: 'caveat-title' }, [h('span', { 'aria-hidden': 'true', text: '⊘' }), '总 token 的口径边界（单算）']),
      h('p', { text: '即便数据尚未发布，也请记住口径：token 只覆盖 Astra 单侧配对样本；「总 token 更少」需要全链路加总并经环境负责人复核。' })
    ]));
    root.appendChild(frag);
  }

  function loadJSON(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 10000) : null;
    var opts = {
      cache: 'no-cache',
      headers: { Accept: 'application/json' }
    };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (timer) clearTimeout(timer);
      return data;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function initEvidence() {
    var root = document.getElementById('evidence-root');
    if (!root) return;
    var live = document.getElementById('ev-live');
    if (live) live.textContent = '正在读取数据文件…';

    loadJSON(DATA_URL).then(function (data) {
      var m = CORE.buildModel(data);
      if (!m) throw new Error('summary.json 结构不符合预期');
      renderEvidence(root, m);
      applyInstall(m);
      applyFooterLinks(m);
      if (live) live.textContent = '数据已就绪。';
    }).catch(function (err) {
      var why = err && err.name === 'AbortError'
        ? '读取超时'
        : (err && err.message ? err.message : '未知错误');
      renderEvidenceFail(root, why);
      applyFooterLinks(null);
      if (live) live.textContent = '数据读取失败，区域保持「待实测」。';
    });
  }

  /* ---------- 安装命令 / 复制 ---------- */

  function applyInstall(m) {
    var sp = document.getElementById('repo-url-text');
    var btn = document.querySelector('.copy-btn[data-copy-source="cmd-clone"]');
    if (!sp || !btn) return;
    if (m && m.links.repo) {
      sp.textContent = m.links.repo;
      sp.classList.remove('code-ph');
      btn.disabled = false;
    } else {
      sp.textContent = 'https://github.com/coppynight/codex-dsh-workflow';
      sp.classList.add('code-ph');
      btn.disabled = false;
    }
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('clipboard unavailable'));
    });
  }

  function initCopyButtons() {
    $all('.copy-btn').forEach(function (btn) {
      var srcId = btn.getAttribute('data-copy-source');
      if (!srcId) return;
      var label = btn.textContent.trim() || '复制';
      btn.setAttribute('aria-label', '复制 ' + srcId + ' 的完整命令');
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        var pre = document.getElementById(srcId);
        if (!pre) return;
        var text = (pre.innerText || pre.textContent || '').trim();
        writeClipboard(text).then(function () {
          announce('copy-live', '已复制命令：' + srcId);
          btn.classList.add('copied');
          btn.textContent = '已复制 ✓';
          setTimeout(function () {
            btn.classList.remove('copied');
            btn.textContent = label;
          }, 1800);
        }).catch(function () {
          announce('copy-live', '复制失败：请手动全选命令文本后复制。');
          btn.textContent = '复制失败';
          setTimeout(function () { btn.textContent = label; }, 1800);
        });
      });
    });
  }

  /* ---------- 页脚 / 动态链接 ---------- */

  function applyFooterLinks(m) {
    var ul = document.getElementById('footer-links');
    if (!ul) return;
    var specs = [
      ['仓库', m && m.links.repo, 'repo'],
      ['示例', m && m.links.examples, 'examples'],
      ['方法学', m && m.links.methodology, 'methodology']
    ];
    $all('[data-dyn]', ul).forEach(function (li) { li.remove(); });
    specs.forEach(function (spec) {
      var a = evMetaLink(spec[0], spec[1], spec[2]);
      if (!a) return;
      var li = h('li', { 'data-dyn': spec[2] }, [a]);
      ul.appendChild(li);
    });
  }

  /* ---------- 启动 ---------- */
  onReady(function () {
    initCopyButtons();
    initEvidence();
  });

  window.DSHPage = {
    CORE: CORE,
    loadJSON: loadJSON
  };
})();
