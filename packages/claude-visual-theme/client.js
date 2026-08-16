window.__ModuleLoader__.load({
  id: '@dsh-plugins/claude-visual-theme',
  factory: (require) => {
    const TOKENS = {
      '--dsw-alias-bg-base': { light: '#fcfcfb', dark: '#151515' },
      '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#1a1a19' },
      '--dsw-alias-bg-layer-2': { light: '#ffffff', dark: '#20201f' },
      '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#20201f' },
      '--dsw-alias-border-l1': { light: 'rgba(11, 11, 11, .1)', dark: 'rgba(255, 255, 255, .1)' },
      '--dsw-alias-border-l2': { light: 'rgba(11, 11, 11, .2)', dark: 'rgba(255, 255, 255, .2)' },
      '--dsw-alias-brand-primary': { light: '#c6613f', dark: '#c6613f' },
      '--dsw-alias-label-primary': { light: '#0b0b0b', dark: '#f0efec' },
      '--dsw-alias-label-secondary': { light: '#52514e', dark: '#c3c2b7' },
      '--dsw-alias-state-error-primary': { light: '#8e2626', dark: '#ec7e7e' },
      '--dsw-alias-state-success-primary': { light: '#006300', dark: '#0ca30c' },
      '--dsw-alias-state-warn-primary': { light: '#734500', dark: '#db9300' },
      '--dsw-specific-sidebar-fill': { light: '#ffffff', dark: '#20201f' }
    }

    const STYLE_ID = 'dsh-claude-visual-theme'
    const CSS = `
      @font-face {
        font-family: "anthropic-sans";
        src: url("https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cc27851ad-DDVos-BJ.woff2") format("woff2");
        font-weight: 300 800;
        font-style: normal;
        font-display: swap;
        font-feature-settings: "dlig" 0;
      }
      @font-face {
        font-family: "Anthropicons-Variable";
        src: url("https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c0f671921-DiY3GvqQ.woff2") format("woff2-variations");
        font-weight: 400 700;
        font-display: block;
      }
      @font-face {
        font-family: "anthropic-mono";
        src: url("https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c5dbe0935-CQcSkHaI.woff2") format("woff2");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      :root, body, #root {
        --dsw-alias-bg-base: #fcfcfb;
        --dsw-alias-bg-layer-1: #ffffff;
        --dsw-alias-bg-layer-2: #ffffff;
        --dsw-alias-bg-overlay: #ffffff;
        --dsw-alias-border-l1: rgba(11, 11, 11, .1);
        --dsw-alias-border-l2: rgba(11, 11, 11, .2);
        --dsw-alias-brand-primary: #c6613f;
        --dsw-alias-label-primary: #0b0b0b;
        --dsw-alias-label-secondary: #52514e;
        --dsw-specific-sidebar-fill: #ffffff;
        --dsh-claude-font: anthropic-sans, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        --dsh-claude-icon-font: "Anthropicons-Variable";
        --dsh-claude-mono: anthropic-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        --dsh-claude-brand: #c6613f;
        --dsh-claude-brand-hover: #d97757;
      }
      body[data-ds-dark-theme], html[data-theme="dark"] body, html[data-mode="dark"] body {
        --dsw-alias-bg-base: #151515;
        --dsw-alias-bg-layer-1: #1a1a19;
        --dsw-alias-bg-layer-2: #20201f;
        --dsw-alias-bg-overlay: #20201f;
        --dsw-alias-border-l1: rgba(255, 255, 255, .1);
        --dsw-alias-border-l2: rgba(255, 255, 255, .2);
        --dsw-alias-label-primary: #f0efec;
        --dsw-alias-label-secondary: #c3c2b7;
        --dsw-specific-sidebar-fill: #20201f;
      }
      body {
        background-color: var(--dsw-alias-bg-base) !important;
        color: var(--dsw-alias-label-primary) !important;
      }
      body, body button, body input, body textarea, body select,
      body :not(pre):not(code):not(kbd):not(samp) {
        font-family: var(--dsh-claude-font) !important;
        font-synthesis: none;
        letter-spacing: 0;
      }
      pre, code, kbd, samp { font-family: var(--dsh-claude-mono) !important; }
      button, input, textarea, select { font-synthesis: none; }
      button { transition: background-color .14s ease, border-color .14s ease, color .14s ease, box-shadow .14s ease; }
      button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
        outline: 2px solid #2a78d6;
        outline-offset: 2px;
      }
      input, textarea, select { border-color: var(--dsw-alias-border-l1); }
      input:hover, textarea:hover, select:hover { border-color: var(--dsw-alias-border-l2); }
      button[aria-label*="发送消息"], button[aria-label*="Send message"], .uV2eYG_primary {
        background: var(--dsh-claude-brand) !important;
      }
      button[aria-label*="发送消息"]:hover, button[aria-label*="Send message"]:hover, .uV2eYG_primary:hover {
        background: var(--dsh-claude-brand-hover) !important;
      }
      ::selection { color: #fff; background: var(--dsh-claude-brand); }

      /* DSH keeps these application shells on fixed light surfaces. Rebind the
         visible shells when its root color-scheme switches to dark. */
      html[style*="color-scheme: dark"] {
        --dsw-alias-bg-base: #151515 !important;
        --dsw-alias-bg-layer-1: #1a1a19 !important;
        --dsw-alias-bg-layer-2: #20201f !important;
        --dsw-alias-bg-overlay: #20201f !important;
        --dsw-alias-border-l1: rgba(255, 255, 255, .1) !important;
        --dsw-alias-border-l2: rgba(255, 255, 255, .2) !important;
        --dsw-alias-label-primary: #f0efec !important;
        --dsw-alias-label-secondary: #c3c2b7 !important;
        --dsw-specific-sidebar-fill: #20201f !important;
      }
      html[style*="color-scheme: dark"] body,
      html[style*="color-scheme: dark"] #root,
      html[style*="color-scheme: dark"] .pI_x6G_frame,
      html[style*="color-scheme: dark"] .wSkVaW_root {
        background-color: #151515 !important;
        color: #f0efec !important;
      }
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol,
      html[style*="color-scheme: dark"] .hHd-Xa_root {
        background-color: #20201f !important;
        color: #f0efec !important;
      }
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol button,
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol input,
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol a,
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol span,
      html[style*="color-scheme: dark"] .wSkVaW_root button,
      html[style*="color-scheme: dark"] .wSkVaW_root input,
      html[style*="color-scheme: dark"] .wSkVaW_root a,
      html[style*="color-scheme: dark"] .wSkVaW_root span {
        color: inherit !important;
      }
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol button:hover,
      html[style*="color-scheme: dark"] .wSkVaW_root button:hover {
        background-color: rgba(255, 255, 255, .08) !important;
      }
      html[style*="color-scheme: dark"] .uV2eYG_primary,
      html[style*="color-scheme: dark"] button[aria-label*="发送消息"],
      html[style*="color-scheme: dark"] button[aria-label*="Send message"] {
        background-color: var(--dsh-claude-brand) !important;
        color: #fff !important;
      }
      html[style*="color-scheme: dark"] .VOzbGW_panel,
      html[style*="color-scheme: dark"] .W-zNGW_pane,
      html[style*="color-scheme: dark"] .W-zNGW_panel,
      html[style*="color-scheme: dark"] .W-zNGW_bottomPanel {
        background-color: #1a1a19 !important;
        color: #f0efec !important;
      }
      html[style*="color-scheme: dark"] .VOzbGW_navCell,
      html[style*="color-scheme: dark"] ._5QVD0a_selector,
      html[style*="color-scheme: dark"] .oY77xG_selector,
      html[style*="color-scheme: dark"] .T1PP_q_selector,
      html[style*="color-scheme: dark"] ._8HJdBW_themeCube {
        color: #f0efec !important;
        border-color: rgba(255, 255, 255, .2) !important;
      }
      html[style*="color-scheme: dark"] .VOzbGW_navCell:hover,
      html[style*="color-scheme: dark"] .VOzbGW_navCell.VOzbGW_active,
      html[style*="color-scheme: dark"] ._5QVD0a_selector,
      html[style*="color-scheme: dark"] .oY77xG_selector,
      html[style*="color-scheme: dark"] .T1PP_q_selector,
      html[style*="color-scheme: dark"] ._8HJdBW_themeCube._8HJdBW_selected {
        background-color: #20201f !important;
      }
      html[style*="color-scheme: dark"] .hHd-Xa_newSession,
      html[style*="color-scheme: dark"] .uV2eYG_card,
      html[style*="color-scheme: dark"] .W-zNGW_tabBar,
      html[style*="color-scheme: dark"] .W-zNGW_tabBarPlus,
      html[style*="color-scheme: dark"] .W-zNGW_paneCard {
        background-color: #20201f !important;
        color: #f0efec !important;
        border-color: rgba(255, 255, 255, .1) !important;
      }
      html[style*="color-scheme: dark"] code,
      html[style*="color-scheme: dark"] pre,
      html[style*="color-scheme: dark"] kbd,
      html[style*="color-scheme: dark"] samp {
        background-color: #20201f !important;
        color: #f0efec !important;
      }
      html[style*="color-scheme: dark"] .pI_x6G_sidebarCol *,
      html[style*="color-scheme: dark"] .wSkVaW_root *,
      html[style*="color-scheme: dark"] .VOzbGW_panel * {
        color: #f0efec !important;
      }
      html[style*="color-scheme: dark"] .VOzbGW_panel button {
        background-color: #20201f !important;
        border-color: rgba(255, 255, 255, .2) !important;
      }
      html[style*="color-scheme: dark"] .VOzbGW_panel button:hover {
        background-color: #2a2a28 !important;
      }
      html[style*="color-scheme: dark"] .uV2eYG_primary,
      html[style*="color-scheme: dark"] button[aria-label*="发送消息"],
      html[style*="color-scheme: dark"] button[aria-label*="Send message"] {
        color: #fff !important;
      }
      html[style*="color-scheme: dark"] .wSkVaW_composerSeat {
        background-image: linear-gradient(rgba(0, 0, 0, 0), #151515 36px) !important;
      }
      html[style*="color-scheme: dark"] .qDHVXG_fade {
        background-image: linear-gradient(rgba(0, 0, 0, 0), #20201f) !important;
      }
      html[style*="color-scheme: dark"] .Md3f7G_turnStatus {
        background-image: linear-gradient(90deg, #c6613f 0%, #c6613f 40%, #d97757 50%, #c6613f 60%, #c6613f 100%) !important;
        background-color: transparent !important;
        background-position: 100% 0 !important;
        background-size: 250% 100% !important;
        background-clip: text !important;
        -webkit-background-clip: text !important;
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        animation: Md3f7G_dsh-turn-status-shimmer 1.8s linear infinite !important;
      }
      /* Keep the running sweep inside the glyphs, never as a row background. */
      html[style*="color-scheme: dark"] .QWLzlG_root[data-state="running"] .QWLzlG_row::after,
      html[style*="color-scheme: dark"] .CY-8Ka_root[data-state="running"]::after,
      html[style*="color-scheme: dark"] .o3BgMG_root[data-state="running"] .o3BgMG_row::after,
      html[style*="color-scheme: dark"] ._Xvjua_root[data-state="running"] ._Xvjua_row::after,
      html[style*="color-scheme: dark"] .iWrAna_card[data-state="running"] .iWrAna_row::after {
        display: none !important;
        background: none !important;
        animation: none !important;
      }
      html[style*="color-scheme: dark"] .QWLzlG_root[data-state="running"] .QWLzlG_title,
      html[style*="color-scheme: dark"] .QWLzlG_root[data-state="running"] .QWLzlG_summary,
      html[style*="color-scheme: dark"] .CY-8Ka_root[data-state="running"] .CY-8Ka_title,
      html[style*="color-scheme: dark"] .CY-8Ka_root[data-state="running"] .CY-8Ka_summary,
      html[style*="color-scheme: dark"] .o3BgMG_root[data-state="running"] .o3BgMG_title,
      html[style*="color-scheme: dark"] .o3BgMG_root[data-state="running"] .o3BgMG_summary,
      html[style*="color-scheme: dark"] .o3BgMG_root[data-state="running"] .o3BgMG_summarySuffix,
      html[style*="color-scheme: dark"] ._Xvjua_root[data-state="running"] ._Xvjua_title,
      html[style*="color-scheme: dark"] ._Xvjua_root[data-state="running"] ._Xvjua_summary,
      html[style*="color-scheme: dark"] .iWrAna_card[data-state="running"] .iWrAna_title,
      html[style*="color-scheme: dark"] .iWrAna_card[data-state="running"] .iWrAna_summary {
        background-image: linear-gradient(90deg, #f0efec 0%, #f0efec 42%, #ffffff 50%, #f0efec 58%, #f0efec 100%) !important;
        background-position: 100% 0 !important;
        background-size: 250% 100% !important;
        background-repeat: no-repeat !important;
        background-clip: text !important;
        -webkit-background-clip: text !important;
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        animation: dsh-claude-text-shimmer 2.6s ease-out infinite !important;
      }
      @keyframes dsh-claude-text-shimmer {
        0% { background-position: 100% 0; }
        90%, 100% { background-position: 0 0; }
      }
    `

    return {
      inject: ['theme'],
      apply(ctx) {
        const theme = ctx.get('theme')
        if (theme !== undefined) {
          ctx.effect(() => theme.overrideTokens('claude-visual-theme', TOKENS), 'claude measured design tokens')
        }
        ctx.effect(() => {
          let style = document.getElementById(STYLE_ID)
          let owned = false
          if (style === null) {
            style = document.createElement('style')
            style.id = STYLE_ID
            style.setAttribute('data-dsh-plugin', 'claude-visual-theme')
            style.textContent = CSS
            document.head.appendChild(style)
            owned = true
          }
          return () => {
            if (owned) style?.remove()
          }
        }, 'claude measured typography and controls')
      }
    }
  }
})
