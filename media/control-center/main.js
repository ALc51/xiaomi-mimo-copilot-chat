(function () {
  "use strict";

  /** @type {import('vscode').WebviewApi<{ tab?: string }> | undefined} */
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

  const root = document.documentElement;
  const body = document.body;

  /** @type {any} */
  let overviewPayload;
  /** @type {any} */
  let billingPayload;
  /** @type {any[]} */
  let debugTurns = [];
  /** @type {any} */
  let settingsPayload;

  let costMetric = "total";
  let usageMode = "single";
  /** @type {string} */
  let usageModelId = "mimo-v2.6-flash";

  const comboCharts = new Map();
  const CHART_H = 220;

  function syncThemeFromHost() {
    const b = document.body;
    if (b.classList.contains("vscode-high-contrast")) {
      root.dataset.theme = "hc-dark";
    } else if (b.classList.contains("vscode-high-contrast-light")) {
      root.dataset.theme = "hc-light";
    } else if (b.classList.contains("vscode-light")) {
      root.dataset.theme = "light";
    } else {
      root.dataset.theme = "dark";
    }
  }

  syncThemeFromHost();
  const themeObserver = new MutationObserver(() => syncThemeFromHost());
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  function $(id) {
    return document.getElementById(id);
  }

  function formatTokensZh(n) {
    return Math.round(Number(n) || 0).toLocaleString("zh-CN");
  }

  function cssVar(name, fallback) {
    return getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  }

  function lineColor() {
    return cssVar("--bill-line", "#A4C1C4");
  }

  function legendHtml(items) {
    return items
      .map((it) => {
        const mark =
          it.kind === "line"
            ? `<span class="line-mark"></span>`
            : `<span class="swatch" style="background:${it.color}"></span>`;
        const val = it.value != null ? `<span class="val">${it.value}</span>` : "";
        return `<span>${mark}${it.label}${val}</span>`;
      })
      .join("");
  }

  /**
   * @param {string} svgId
   * @param {string|null} tipId
   * @param {Array<{ label?: string; color: string; values: number[]; format?: function }>} series
   * @param {function} formatTick
   * @param {function} formatValue
   * @param {Array<{ label: string; color?: string; values: number[]; format?: function }>|undefined} tipExtras
   * @param {{ el: HTMLElement | null; items: any[] }|undefined} legendSync
   * @param {Array<{ label: string; date: string }>} daily
   */
  function renderCombo(svgId, tipId, series, formatTick, formatValue, tipExtras, legendSync, daily) {
    const svg = $(svgId);
    const tip = tipId ? $(tipId) : null;
    if (!svg) return;
    const wrap = svg.parentElement;
    const H = CHART_H;
    const padL = 44,
      padR = 8,
      padT = 8,
      padB = 28;
    const n = daily.length;
    const totals = daily.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0));
    const max = Math.max(...totals, 1e-9);
    const tickCount = 5;
    const labelIdx = new Set(
      n <= 7 ? Array.from({ length: n }, (_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1]
    );
    if (n > 10) {
      for (let i = 5; i < n - 1; i += 5) labelIdx.add(i);
    }
    const fmtVal =
      formatValue ||
      ((v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2)));
    let lastHover = -1;

    function layout() {
      const W = Math.max(240, Math.floor((wrap && wrap.clientWidth) || svg.clientWidth || 280));
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const slot = n > 0 ? plotW / n : plotW;
      const barW = n > 0 ? Math.max(8, Math.min(64, slot * 0.82)) : 0;
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      svg.removeAttribute("viewBox");
      svg.removeAttribute("preserveAspectRatio");
      return { W, plotW, plotH, slot, barW };
    }

    function paint(hoverIdx) {
      if (n === 0) {
        svg.innerHTML = "";
        if (tip) tip.style.display = "none";
        if (legendSync && legendSync.el) legendSync.el.innerHTML = "";
        return;
      }
      const stroke = cssVar("--border", "#3c3c3c");
      const dim = cssVar("--dim", "#9d9d9d");
      const line = cssVar("--bill-line", "#A4C1C4");
      const elev = cssVar("--elevated", "#fff");
      const { W, plotH, slot, barW } = layout();
      lastHover = hoverIdx;
      let html = "";
      for (let i = 0; i <= tickCount; i++) {
        const frac = i / tickCount;
        const y = padT + plotH - frac * plotH;
        html += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${stroke}" stroke-dasharray="2 4" stroke-width="1"/>`;
        html += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="${dim}" font-size="12" font-family="system-ui,sans-serif">${formatTick(max * frac)}</text>`;
      }
      if (hoverIdx >= 0 && hoverIdx < n) {
        html += `<rect x="${padL + slot * hoverIdx}" y="${padT}" width="${slot}" height="${plotH}" fill="rgba(0,0,0,0.04)"/>`;
      }
      daily.forEach((d, i) => {
        const x = padL + slot * i + (slot - barW) / 2;
        let y = padT + plotH;
        const opacity = hoverIdx >= 0 && hoverIdx !== i ? 0.35 : 1;
        html += `<g opacity="${opacity}">`;
        series.forEach((ser) => {
          const h = ((ser.values[i] ?? 0) / max) * plotH;
          y -= h;
          html += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h, 0)}" fill="${ser.color}"/>`;
        });
        if (labelIdx.has(i)) {
          html += `<text x="${padL + slot * i + slot / 2}" y="${H - 10}" text-anchor="middle" fill="${dim}" font-size="11" font-family="system-ui,sans-serif">${d.label}</text>`;
        }
        html += `</g>`;
      });
      const pts = totals
        .map((t, i) => {
          const x = padL + slot * i + slot / 2;
          const y = padT + plotH - (t / max) * plotH;
          return `${x},${y}`;
        })
        .join(" ");
      html += `<polyline points="${pts}" fill="none" stroke="${line}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>`;
      totals.forEach((t, i) => {
        const x = padL + slot * i + slot / 2;
        const y = padT + plotH - (t / max) * plotH;
        const r = hoverIdx === i ? 4.5 : 3;
        html += `<circle cx="${x}" cy="${y}" r="${r}" fill="${elev}" stroke="${line}" stroke-width="${hoverIdx === i ? 2 : 1.5}"/>`;
      });
      if (hoverIdx >= 0 && hoverIdx < n) {
        const cx = padL + slot * hoverIdx + slot / 2;
        html += `<line x1="${cx}" x2="${cx}" y1="${padT}" y2="${padT + plotH}" stroke="${line}" stroke-width="1" stroke-dasharray="4 3"/>`;
      }
      svg.innerHTML = html;

      if (legendSync && legendSync.el && legendSync.items) {
        legendSync.el.innerHTML = legendHtml(
          legendSync.items.map((it) => {
            const vals = it.values || [];
            const idx = hoverIdx >= 0 && hoverIdx < vals.length ? hoverIdx : null;
            const nVal = idx != null ? vals[idx] : vals.reduce((s, v) => s + v, 0);
            const fmt = it.format || fmtVal;
            return {
              kind: it.kind || "bar",
              color: it.color,
              label: it.label,
              value: fmt(nVal, idx),
            };
          })
        );
      }

      if (!tip) return;
      if (hoverIdx < 0 || hoverIdx >= n) {
        tip.style.display = "none";
        return;
      }
      const rows = [
        ...(tipExtras || []).map((ex) => ({
          label: ex.label,
          color: ex.color || line,
          value: (ex.format || fmtVal)(ex.values[hoverIdx], hoverIdx),
        })),
        ...series.map((ser) => ({
          label: ser.label || "系列",
          color: ser.color,
          value: (ser.format || fmtVal)(ser.values[hoverIdx], hoverIdx),
        })),
      ];
      const dateStr = daily[hoverIdx].date || "";
      tip.innerHTML =
        `<div class="tip-date">${dateStr}</div>` +
        rows
          .map((r) =>
            `<div class="tip-row"><div class="tip-left"><span class="tip-dot" style="background:${r.color}"></span><span class="tip-label">${r.label}</span></div><span class="tip-val">${r.value}</span></div>`
          )
          .join("");
      const { W: W2, slot: slot2 } = layout();
      const leftPct = Math.min(
        72,
        Math.max(8, ((padL + slot2 * hoverIdx + slot2 / 2) / W2) * 100)
      );
      tip.style.display = "block";
      tip.style.top = "24px";
      tip.style.left = leftPct + "%";
      tip.style.transform = leftPct > 55 ? "translateX(-100%)" : "translateX(8px)";
    }

    paint(-1);
    svg.onmousemove = (e) => {
      if (n === 0) return;
      const { W, slot } = layout();
      const x = e.clientX - svg.getBoundingClientRect().left;
      if (x < padL || x > W - padR) {
        paint(-1);
        return;
      }
      paint(Math.min(n - 1, Math.max(0, Math.floor((x - padL) / slot))));
    };
    svg.onmouseleave = () => paint(-1);

    const prev = comboCharts.get(svgId);
    if (prev && prev.ro) prev.ro.disconnect();
    if (wrap && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => paint(lastHover));
      ro.observe(wrap);
      comboCharts.set(svgId, { ro });
    }
  }

  function isFlashModelId(id) {
    return /flash/i.test(id || "");
  }

  /** Prefer official byModel stats; fall back to flash/pro share of day totals. */
  function modelDayStat(d, modelId) {
    const hit = d.byModel && d.byModel[modelId];
    if (hit) {
      return {
        cost: hit.cost || 0,
        cachedTok: hit.cachedTok || 0,
        uncachedTok: hit.uncachedTok || 0,
        outputTok: hit.outputTok || 0,
      };
    }
    const scale = isFlashModelId(modelId)
      ? d.flashTok / Math.max(d.flashTok + d.proTok, 0.01)
      : d.proTok / Math.max(d.flashTok + d.proTok, 0.01);
    return {
      cost: isFlashModelId(modelId) ? d.flashCost || 0 : d.proCost || 0,
      cachedTok: (d.cachedTok || 0) * scale,
      uncachedTok: (d.uncachedTok || 0) * scale,
      outputTok: (d.outputTok || 0) * scale,
    };
  }

  function syncUsageModeChrome(daily) {
    const modelRow = $("usage-model-row");
    const usageTitleParent = $("usage-title");
    const sumPlaceholder = "—";
    const needModelPicker = usageMode === "single" || costMetric === "single";
    if (modelRow) modelRow.style.display = needModelPicker ? "flex" : "none";
    const selLabel =
      (billingPayload && billingPayload.models || []).find((m) => m.id === usageModelId)?.label ||
      usageModelId;
    const trig = $("usage-model-trigger");
    if (trig && needModelPicker) trig.textContent = selLabel;
    if (usageMode === "total") {
      if (usageTitleParent) {
        usageTitleParent.replaceChildren();
        usageTitleParent.append("Token 总消耗", document.createElement("span"));
        usageTitleParent.lastChild.className = "pipe";
        usageTitleParent.lastChild.textContent = "|";
        const sum = document.createElement("span");
        sum.id = "usage-sum";
        sum.textContent = sumPlaceholder;
        usageTitleParent.appendChild(sum);
      }
    } else {
      if (usageTitleParent) {
        usageTitleParent.replaceChildren();
        usageTitleParent.append("单模型 Token 消耗", document.createElement("span"));
        usageTitleParent.lastChild.className = "pipe";
        usageTitleParent.lastChild.textContent = "|";
        const sum = document.createElement("span");
        sum.id = "usage-sum";
        sum.textContent = sumPlaceholder;
        usageTitleParent.appendChild(sum);
      }
    }
    void daily;
  }

  function paintCharts() {
    const green = cssVar("--bill-green", "#C7E2A8");
    const purple = cssVar("--bill-purple", "#A7A3D8");
    const peach = cssVar("--bill-peach", "#F5C9B0");
    const daily = billingPayload && Array.isArray(billingPayload.daily) ? billingPayload.daily : [];

    const fmtCostAxis = (v) => (v >= 10 ? String(Math.round(v)) : Number(v).toFixed(1));
    const fmtCostVal = (v) => Number(v).toFixed(2);
    const tokFmt = (v) => formatTokensZh(v);
    const reqFmt = (v) => String(Math.round(v));

    // Always sync usage chrome (title + model picker) even when series is empty.
    syncUsageModeChrome(daily);

    if (daily.length === 0) {
      ["chart-cost", "chart-usage", "chart-req"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
      });
      ["cost-legend", "usage-legend", "req-legend"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "";
      });
      const costSum = $("cost-head-sum");
      if (costSum) costSum.textContent = "—";
      const reqSumEmpty = $("req-head-sum");
      if (reqSumEmpty) reqSumEmpty.textContent = "—";
      return;
    }

    let costSeries;
    let costExtras;
    let costLegendItems;
    if (costMetric === "model") {
      costSeries = [
        { label: "mimo-v2.6-flash", color: green, values: daily.map((d) => d.flashCost) },
        { label: "mimo-v2.6-pro", color: purple, values: daily.map((d) => d.proCost) },
      ];
      costExtras = [
        { label: "模型消费金额", color: lineColor(), values: daily.map((d) => d.flashCost + d.proCost) },
      ];
      costLegendItems = [
        {
          kind: "line",
          color: lineColor(),
          label: "模型消费金额",
          values: daily.map((d) => d.flashCost + d.proCost),
          format: fmtCostVal,
        },
        { kind: "bar", color: green, label: "mimo-v2.6-flash", values: daily.map((d) => d.flashCost), format: fmtCostVal },
        { kind: "bar", color: purple, label: "mimo-v2.6-pro", values: daily.map((d) => d.proCost), format: fmtCostVal },
      ];
    } else if (costMetric === "plugin") {
      costSeries = [{ label: "插件消费总金额", color: purple, values: daily.map((d) => d.pluginCost) }];
      costExtras = [{ label: "插件消费总金额", color: lineColor(), values: daily.map((d) => d.pluginCost) }];
      costLegendItems = [
        {
          kind: "line",
          color: lineColor(),
          label: "插件消费总金额",
          values: daily.map((d) => d.pluginCost),
          format: fmtCostVal,
        },
      ];
    } else if (costMetric === "single") {
      const singleCosts = daily.map((d) => modelDayStat(d, usageModelId).cost);
      const singleLabel =
        (billingPayload && billingPayload.models || []).find((m) => m.id === usageModelId)?.label ||
        usageModelId;
      costSeries = [{ label: singleLabel, color: green, values: singleCosts }];
      costExtras = [{ label: "单模型消费金额", color: lineColor(), values: singleCosts }];
      costLegendItems = [
        {
          kind: "line",
          color: lineColor(),
          label: singleLabel,
          values: singleCosts,
          format: fmtCostVal,
        },
      ];
    } else {
      costSeries = [
        { label: "模型消费金额", color: green, values: daily.map((d) => d.flashCost + d.proCost) },
        { label: "插件消费总金额", color: purple, values: daily.map((d) => d.pluginCost) },
      ];
      costExtras = [{ label: "总体消费金额", color: lineColor(), values: daily.map((d) => d.cost) }];
      costLegendItems = [
        {
          kind: "line",
          color: lineColor(),
          label: "总体消费金额",
          values: daily.map((d) => d.cost),
          format: fmtCostVal,
        },
        {
          kind: "bar",
          color: green,
          label: "模型消费金额",
          values: daily.map((d) => d.flashCost + d.proCost),
          format: fmtCostVal,
        },
        {
          kind: "bar",
          color: purple,
          label: "插件消费总金额",
          values: daily.map((d) => d.pluginCost),
          format: fmtCostVal,
        },
      ];
    }

    const costTitle = $("cost-head-title");
    const costSum = $("cost-head-sum");
    if (costTitle && costSum && billingPayload) {
      if (costMetric === "model") {
        costTitle.textContent = "模型消费金额";
        const t = daily.reduce((s, d) => s + d.flashCost + d.proCost, 0);
        costSum.textContent = fmtCostVal(t);
      } else if (costMetric === "plugin") {
        costTitle.textContent = "插件消费总金额";
        const t = daily.reduce((s, d) => s + d.pluginCost, 0);
        costSum.textContent = fmtCostVal(t);
      } else if (costMetric === "single") {
        const singleLabel =
          (billingPayload && billingPayload.models || []).find((m) => m.id === usageModelId)?.label ||
          usageModelId;
        costTitle.textContent = singleLabel;
        const t = daily.reduce((s, d) => s + modelDayStat(d, usageModelId).cost, 0);
        costSum.textContent = fmtCostVal(t);
      } else {
        costTitle.textContent = "总体消费金额";
        costSum.textContent = billingPayload.totalCostLabel || "—";
      }
    }

    renderCombo(
      "chart-cost",
      "tip-cost",
      costSeries,
      fmtCostAxis,
      fmtCostVal,
      costExtras,
      { el: $("cost-legend"), items: costLegendItems },
      daily
    );

    const flashTokTot = daily.reduce((s, d) => s + d.flashTok, 0);
    const proTokTot = daily.reduce((s, d) => s + d.proTok, 0);

    const singleCached = daily.map((d) => modelDayStat(d, usageModelId).cachedTok);
    const singleUncached = daily.map((d) => modelDayStat(d, usageModelId).uncachedTok);
    const singleOutput = daily.map((d) => modelDayStat(d, usageModelId).outputTok);
    const singleSum =
      singleCached.reduce((s, v) => s + v, 0) +
      singleUncached.reduce((s, v) => s + v, 0) +
      singleOutput.reduce((s, v) => s + v, 0);

    if (usageMode === "total") {
      const usageSeries = [
        { label: "mimo-v2.6-flash", color: green, values: daily.map((d) => d.flashTok) },
        { label: "mimo-v2.6-pro", color: purple, values: daily.map((d) => d.proTok) },
      ];
      renderCombo(
        "chart-usage",
        "tip-usage",
        usageSeries,
        (v) => {
          if (v >= 1000) return formatTokensZh(v);
          return String(Math.round(v));
        },
        tokFmt,
        [{ label: "Token 总消耗", color: lineColor(), values: daily.map((d) => d.flashTok + d.proTok) }],
        {
          el: $("usage-legend"),
          items: [
            {
              kind: "line",
              color: lineColor(),
              label: "Token 总消耗",
              values: daily.map((d) => d.flashTok + d.proTok),
              format: tokFmt,
            },
            { kind: "bar", color: green, label: "mimo-v2.6-flash", values: daily.map((d) => d.flashTok), format: tokFmt },
            { kind: "bar", color: purple, label: "mimo-v2.6-pro", values: daily.map((d) => d.proTok), format: tokFmt },
          ],
        },
        daily
      );
      const usageSum = $("usage-sum");
      if (usageSum) usageSum.textContent = formatTokensZh(flashTokTot + proTokTot) + " Tokens";
    } else {
      const usageSeries = [
        { label: "输入 (命中缓存) Token", color: green, values: singleCached },
        { label: "输入 (未命中缓存) Token", color: purple, values: singleUncached },
        { label: "输出 Token", color: peach, values: singleOutput },
      ];
      const cachedFmt = (hit, miss) => {
        const den = hit + miss;
        const pct = den > 0 ? ((hit / den) * 100).toFixed(2) : "0.00";
        return formatTokensZh(hit) + "（" + pct + "%）";
      };
      const cachedShareFmt = (_n, idx) =>
        idx == null
          ? cachedFmt(singleCached.reduce((s, v) => s + v, 0), singleUncached.reduce((s, v) => s + v, 0))
          : cachedFmt(singleCached[idx], singleUncached[idx]);
      usageSeries[0].format = cachedShareFmt;
      const dayTotal = daily.map((_, i) => singleCached[i] + singleUncached[i] + singleOutput[i]);
      renderCombo(
        "chart-usage",
        "tip-usage",
        usageSeries,
        (v) => {
          if (v >= 1000) return formatTokensZh(v);
          return String(Math.round(v));
        },
        tokFmt,
        [{ label: "Token 总消耗", color: lineColor(), values: dayTotal }],
        {
          el: $("usage-legend"),
          items: [
            { kind: "line", color: lineColor(), label: "Token 总消耗", values: dayTotal, format: tokFmt },
            { kind: "bar", color: green, label: "输入 (命中缓存) Token", values: singleCached, format: cachedShareFmt },
            { kind: "bar", color: purple, label: "输入 (未命中缓存) Token", values: singleUncached, format: tokFmt },
            { kind: "bar", color: peach, label: "输出 Token", values: singleOutput, format: tokFmt },
          ],
        },
        daily
      );
      const usageSum = $("usage-sum");
      if (usageSum) usageSum.textContent = formatTokensZh(singleSum) + " Tokens";
    }

    const reqTotal = daily.reduce((s, d) => s + d.flashReq + d.proReq, 0);
    const reqSum = $("req-head-sum");
    if (reqSum) reqSum.textContent = String(reqTotal) + " 次";

    renderCombo(
      "chart-req",
      "tip-req",
      [
        { label: "mimo-v2.6-pro", color: purple, values: daily.map((d) => d.proReq) },
        { label: "mimo-v2.6-flash", color: green, values: daily.map((d) => d.flashReq) },
      ],
      (v) => String(Math.round(v)),
      reqFmt,
      [{ label: "请求次数", color: lineColor(), values: daily.map((d) => d.flashReq + d.proReq) }],
      {
        el: $("req-legend"),
        items: [
          {
            kind: "line",
            color: lineColor(),
            label: "请求次数",
            values: daily.map((d) => d.flashReq + d.proReq),
            format: reqFmt,
          },
          { kind: "bar", color: green, label: "mimo-v2.6-flash", values: daily.map((d) => d.flashReq), format: reqFmt },
          { kind: "bar", color: purple, label: "mimo-v2.6-pro", values: daily.map((d) => d.proReq), format: reqFmt },
        ],
      },
      daily
    );
  }

  function applyOverview(p) {
    overviewPayload = p;
    body.classList.toggle("token-plan", p.plan === "token-plan");
    body.classList.toggle("exhausted", !!p.quotaExhausted);
    $("banner-text").textContent = p.plan === "token-plan" ? "已达到配额" : "余额不足";
    const btnConsole = $("btn-console");
    if (btnConsole) btnConsole.title = p.consoleTitle;
    const icon = $("brand-icon");
    if (icon && p.iconUri) icon.src = p.iconUri;
    $("model-name").textContent = p.modelName;
    $("cost-hero").textContent = p.costLabel;
    $("breakdown").textContent = p.breakdown || "";
    $("bar-a").style.width = p.barWidths.a + "%";
    $("bar-b").style.width = p.barWidths.b + "%";
    $("bar-c").style.width = p.barWidths.c + "%";
    $("balance-amount").textContent = p.balanceLabel;
    $("balance-hint").textContent = p.balanceHint;
    const be = $("balance-error");
    if (be) {
      if (p.balanceError) {
        be.style.display = "block";
        be.textContent = "余额：" + p.balanceError;
      } else {
        be.style.display = "none";
      }
    }
    $("quota-hero").textContent = p.quotaHero;
    $("quota-reset").textContent = p.quotaReset || "";
    $("quota-fill").style.width = Math.min(100, p.quotaUsedPercent) + "%";
    const qe = $("quota-error");
    if (qe) {
      if (p.quotaError) {
        qe.style.display = "block";
        qe.textContent = p.quotaError;
      } else {
        qe.style.display = "none";
      }
    }
    $("stat-speed").textContent = p.tokPerSec;
    $("stat-cache").textContent = p.cache;
    $("stat-ttft").textContent = p.ttft;
    $("kv-prompt").textContent = p.prompt;
    $("kv-completion").textContent = p.completion;
    $("kv-cached").textContent = p.cached;
    $("kv-uncached").textContent = p.uncached;
    $("session-cost").textContent = p.sessionCostLabel;
    $("session-label").textContent = "本会话累计" + p.sessionTurns + "轮";
    $("session-turns").textContent = p.sessionTurns + " 轮";
    const fresh = $("account-freshness");
    if (fresh) {
      if (p.accountFreshnessNote) {
        fresh.style.display = "block";
        fresh.textContent = p.accountFreshnessNote;
      } else {
        fresh.style.display = "none";
        fresh.textContent = "";
      }
    }
    const ps = $("price-source-wrap");
    if (ps) {
      ps.replaceChildren();
      const line1 = document.createElement("div");
      line1.textContent = "价目来源 · 官方按量价目";
      ps.appendChild(line1);
      if (p.priceSource) {
        const line2 = document.createElement("div");
        line2.textContent = p.priceSource;
        ps.appendChild(line2);
      }
    }
  }

  function rebuildUsageModelSelect() {
    const models = (billingPayload && billingPayload.models) || [];
    const menu = $("usage-model-menu");
    const trig = $("usage-model-trigger");
    const wrap = $("usage-model");
    if (!menu || !trig || !wrap) return;

    menu.innerHTML = "";
    if (!models.length) {
      usageModelId = "mimo-v2.6-flash";
      trig.textContent = usageModelId;
      return;
    }
    let picked = models.find((m) => m.id === usageModelId);
    if (!picked) {
      picked = models.find((m) => isFlashModelId(m.id)) || models[0];
      usageModelId = picked.id;
    }
    trig.textContent = picked.label;
    wrap.dataset.value = usageModelId;
    models.forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fancy-select-option" + (m.id === usageModelId ? " selected" : "");
      btn.dataset.value = m.id;
      btn.textContent = m.label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        usageModelId = m.id;
        wrap.dataset.value = usageModelId;
        trig.textContent = m.label;
        menu.querySelectorAll(".fancy-select-option").forEach((o) => {
          o.classList.toggle("selected", o === btn);
        });
        wrap.classList.remove("open");
        paintCharts();
      });
      menu.appendChild(btn);
    });
  }

  function applyBilling(b) {
    billingPayload = b;
    const note = $("billing-source");
    if (note) note.textContent = b.sourceNote || "";
    const pill = $("billing-source-pill");
    if (pill) {
      pill.textContent =
        b.source === "official" ? "官网" : b.source === "local" ? "本地" : "不可用";
    }
    $("bill-total-cost").textContent = b.totalCostLabel || "—";
    $("bill-total-tokens").textContent = formatTokensZh(b.totalTokens || 0);
    $("bill-cached-share").textContent = b.cachedShareLabel || "—";
    $("bill-uncached-tok").textContent = formatTokensZh(b.uncachedTokens || 0);
    $("bill-output-tok").textContent = formatTokensZh(b.outputTokens || 0);
    const hint = document.querySelector("#panel-billing .balance .hint");
    if (hint) {
      hint.textContent = b.source === "official" ? "近 7 日折后消费" : "基于最近请求估算";
    }
    const rhs = $("req-head-sum");
    if (rhs) rhs.textContent = String(b.requestCount || 0) + " 次";
    rebuildUsageModelSelect();
    paintCharts();
  }

  let selectedTurnId = "";
  /** Once the user clicks a turn head, stop auto-following running requests. */
  let userLockedTurnSelection = false;

  function statusClass(status) {
    if (status === "failure" || status === "canceled") return "bad";
    return "ok";
  }

  /** Prefer the newest running turn; otherwise the first card. */
  function autoFollowTurnId(turns) {
    const running = turns.find((t) => t.status === "running");
    if (running) return running.id;
    return turns[0] ? turns[0].id : "";
  }

  function debugDetailHtml(card) {
    return (
      '<div class="debug-stats">' +
      '<div class="stat"><strong>' +
      escapeHtml(card.duration) +
      '</strong><span>耗时</span></div>' +
      '<div class="stat"><strong>' +
      escapeHtml(card.cache) +
      '</strong><span>Cache</span></div>' +
      '<div class="stat"><strong>' +
      escapeHtml(card.cost) +
      '</strong><span>费用</span></div>' +
      "</div>" +
      '<div class="debug-summary">' +
      '<div class="k">Turn ID</div><div class="v"><code>' +
      escapeHtml(card.id) +
      "</code></div>" +
      '<div class="k">工具调用</div><div class="v">' +
      String(card.tools ?? 0) +
      "</div>" +
      '<div class="k">状态</div><div class="v">' +
      escapeHtml(card.status) +
      "</div>" +
      (card.error
        ? '<div class="k">错误</div><div class="v">' + escapeHtml(card.error) + "</div>"
        : "") +
      "</div>" +
      '<div class="actions" style="justify-content:flex-end">' +
      '<button type="button" class="btn-open-turn-detail" data-turn-id="' +
      escapeHtml(card.id) +
      '">打开详情</button>' +
      "</div>"
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function applyDebug(turns) {
    debugTurns = turns || [];
    const list = $("debug-turn-list");
    if (!list) return;
    list.innerHTML = "";
    if (debugTurns.length === 0) {
      selectedTurnId = "";
      userLockedTurnSelection = false;
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "尚无请求记录。";
      list.appendChild(empty);
      return;
    }
    const stillExists = selectedTurnId && debugTurns.some((t) => t.id === selectedTurnId);
    if (!userLockedTurnSelection) {
      // Before any user click: always track the current running request (or newest).
      selectedTurnId = autoFollowTurnId(debugTurns);
    } else if (!stillExists) {
      // Locked selection vanished (cleared/pruned) — resume auto-follow.
      userLockedTurnSelection = false;
      selectedTurnId = autoFollowTurnId(debugTurns);
    }
    for (const card of debugTurns) {
      const el = document.createElement("div");
      el.className = "turn" + (card.id === selectedTurnId ? " active" : "");
      el.dataset.turnId = card.id;
      el.innerHTML =
        '<div class="turn-head">' +
        '<div class="row" style="margin:0"><strong class="emph">' +
        escapeHtml(card.model) +
        '</strong><span class="pill ' +
        statusClass(card.status) +
        '">' +
        escapeHtml(card.status) +
        "</span></div>" +
        '<div class="meta">' +
        escapeHtml(card.meta) +
        "</div></div>" +
        '<div class="turn-detail">' +
        debugDetailHtml(card) +
        "</div>";
      el.querySelector(".turn-head").addEventListener("click", () => {
        userLockedTurnSelection = true;
        if (selectedTurnId === card.id) {
          selectedTurnId = "";
          el.classList.remove("active");
          return;
        }
        selectedTurnId = card.id;
        list.querySelectorAll(".turn").forEach((t) => t.classList.remove("active"));
        el.classList.add("active");
      });
      list.appendChild(el);
    }
  }

  function applySettings(s) {
    settingsPayload = s;
    $("key-mask").textContent = s.keyMask;
    $("base-url").textContent = s.baseUrl;
    $("cfg-thinking").textContent = s.thinking;
    $("cfg-max-tok").textContent = String(s.maxCompletionTokens);
    $("cfg-websearch").textContent = s.webSearch ? "开启" : "关闭";
    $("cfg-currency").textContent = s.currency;
  }

  function setActiveTab(tab) {
    const tabs = document.querySelectorAll("#tabs button[data-tab]");
    const panels = document.querySelectorAll(".panel");
    tabs.forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    panels.forEach((p) => {
      p.classList.toggle("active", p.id === "panel-" + tab);
    });
  }

  function bindTabs() {
    $("tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      const tab = btn.dataset.tab;
      setActiveTab(tab);
      vscode && vscode.postMessage({ type: "selectTab", tab });
    });
  }

  function bindBillingControls() {
    $("cost-metric").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-metric]");
      if (!btn) return;
      costMetric = btn.dataset.metric;
      document.querySelectorAll("#cost-metric button").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      paintCharts();
    });
    $("usage-mode").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      usageMode = btn.dataset.mode;
      document.querySelectorAll("#usage-mode button").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      paintCharts();
    });
    const usageModelEl = $("usage-model");
    const usageModelTrigger = $("usage-model-trigger");
    if (usageModelTrigger && usageModelEl) {
      usageModelTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        usageModelEl.classList.toggle("open");
      });
    }
    document.addEventListener("click", () => {
      const el = $("usage-model");
      if (el) el.classList.remove("open");
    });
  }

  function bindActions() {
    $("btn-refresh").addEventListener("click", () => vscode && vscode.postMessage({ type: "refresh" }));
    $("btn-console").addEventListener("click", () => vscode && vscode.postMessage({ type: "openConsole" }));
    $("btn-open-settings").addEventListener("click", () =>
      vscode && vscode.postMessage({ type: "openSettings" })
    );
    $("btn-manage-key").addEventListener("click", () =>
      vscode && vscode.postMessage({ type: "manageKey" })
    );
    $("btn-clear-key").addEventListener("click", () =>
      vscode && vscode.postMessage({ type: "clearKey" })
    );
    const btnClearDebug = $("btn-clear-debug");
    if (btnClearDebug) {
      btnClearDebug.addEventListener("click", () =>
        vscode && vscode.postMessage({ type: "clearDebug" })
      );
    }
    $("btn-output-console").addEventListener("click", () =>
      vscode && vscode.postMessage({ type: "showOutputChannel" })
    );
    $("debug-turn-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".btn-open-turn-detail");
      if (!btn) return;
      e.stopPropagation();
      const turnId = btn.getAttribute("data-turn-id") || selectedTurnId;
      vscode && vscode.postMessage({ type: "openTurnDetail", turnId });
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "selectTab" && msg.tab) {
      setActiveTab(msg.tab);
      return;
    }
    if (msg.type === "updateDebug") {
      applyDebug(msg.debugTurns || []);
      return;
    }
    if (msg.type === "updateOverview" && msg.overview) {
      applyOverview(msg.overview);
      return;
    }
    if (msg.type !== "update" || !msg.payload) return;
    const { overview, billing, debugTurns: turns, settings } = msg.payload;
    if (overview) applyOverview(overview);
    if (billing) applyBilling(billing);
    if (turns) applyDebug(turns);
    if (settings) applySettings(settings);
  });

  bindTabs();
  bindBillingControls();
  bindActions();

  vscode && vscode.postMessage({ type: "ready" });
})();
