/**
 * Field UI stylesheet. Shipped as a file (styles.css) so pages can use a strict
 * `style-src 'self'` CSP. Navy base, teal accent, gold as a supplementary marker.
 * Text colours meet WCAG AA (4.5:1) on their backgrounds; targets are ≥ 48px.
 */
export const FRAMEWORK_UI_CSS = `
:root{--fw-navy:#0b2545;--fw-navy-2:#13315c;--fw-teal:#0f766e;--fw-teal-dark:#0b5d57;--fw-teal-weak:#e3f3f1;--fw-gold:#c9a227;--fw-gold-weak:#fbf1d3;--fw-gold-ink:#5b4300;--fw-ink:#0f1b2d;--fw-muted:#44546a;--fw-line:#cfd8e3;--fw-bg:#f2f5f9;--fw-white:#fff;--fw-danger:#b42318;--fw-danger-weak:#fdecea;--fw-ok:#05603a;--fw-ok-weak:#e3f5ec}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--fw-bg);color:var(--fw-ink);font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;font-size:18px;line-height:1.65}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--fw-teal-dark)}
:focus-visible{outline:3px solid var(--fw-gold);outline-offset:2px}
[hidden]{display:none!important}
.fw-app{min-height:100vh;display:flex;flex-direction:column;padding-bottom:72px}
.fw-skip{position:absolute;left:-9999px;top:0;background:var(--fw-white);padding:8px 12px;z-index:10}
.fw-skip:focus{left:8px}
.fw-header{background:var(--fw-navy);color:var(--fw-white);padding:12px 16px 14px;border-bottom:4px solid var(--fw-gold)}
.fw-header-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;max-width:720px;margin:0 auto}
.fw-header-sub{font-size:15px;color:#d7e2ef;margin-top:4px;justify-content:space-between}
.fw-brand{color:var(--fw-white);font-weight:800;font-size:20px;text-decoration:none;letter-spacing:.02em}
.fw-demo-controls{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:720px;margin:10px auto 0}
.fw-demo-controls .fw-field{margin-top:0}
.fw-demo-controls .fw-label{color:#d7e2ef;font-size:14px}
.fw-demo-controls .fw-input{min-height:48px;background:var(--fw-navy-2);color:var(--fw-white);border-color:#5d7593}
.fw-banner{margin:0;padding:10px 16px;font-size:15px;line-height:1.55}
.fw-banner-demo{background:var(--fw-gold-weak);color:var(--fw-gold-ink);border-bottom:1px solid #e6d28f}
.fw-banner-training{background:var(--fw-teal-weak);color:var(--fw-teal-dark);border-radius:10px;font-weight:700}
.fw-offline,.fw-alert{margin:12px auto 0;max-width:720px;width:calc(100% - 32px);padding:12px 14px;border-radius:10px;font-weight:700}
.fw-offline{background:var(--fw-gold-weak);color:var(--fw-gold-ink)}
.fw-alert{background:var(--fw-danger-weak);color:var(--fw-danger);border:2px solid var(--fw-danger)}
.fw-main{flex:1;width:100%;max-width:720px;margin:0 auto;padding:16px}
.fw-main:focus{outline:none}
.fw-stack>*+*{margin-top:14px}
.fw-h1{font-size:26px;line-height:1.35;margin:4px 0 8px;color:var(--fw-navy)}
.fw-h1:focus{outline:none}
.fw-h2{font-size:20px;margin:0 0 10px;color:var(--fw-navy)}
.fw-h3{font-size:18px;margin:12px 0 6px}
.fw-lead{font-size:18px;margin:0}
.fw-note{font-size:16px;color:var(--fw-muted);margin:6px 0}
.fw-meta{font-size:15px;color:var(--fw-muted);margin:6px 0}
.fw-hint{font-size:15px;color:var(--fw-muted);margin:4px 0 0}
.fw-empty{background:var(--fw-white);border:1px dashed var(--fw-line);border-radius:12px;padding:16px;color:var(--fw-muted)}
.fw-loading{padding:24px 0;color:var(--fw-muted);font-weight:700}
.fw-card{background:var(--fw-white);border:1px solid var(--fw-line);border-radius:14px;padding:16px;margin:0}
.fw-search{display:block}
.fw-search-row{display:flex;gap:8px}
.fw-search-row .fw-input{flex:1}
.fw-label{display:block;font-weight:700;font-size:16px;margin-bottom:6px}
.fw-input{width:100%;min-height:52px;border:2px solid #8a9bb0;border-radius:10px;padding:10px 12px;background:var(--fw-white)}
.fw-input:focus{border-color:var(--fw-teal)}
textarea.fw-input{min-height:96px;resize:vertical}
.fw-field+.fw-field{margin-top:12px}
.fw-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.fw-chip{display:inline-flex;align-items:center;min-height:48px;padding:8px 16px;border-radius:999px;border:2px solid var(--fw-navy);color:var(--fw-navy);background:var(--fw-white);text-decoration:none;font-weight:700;font-size:16px}
.fw-chip.is-active{background:var(--fw-navy);color:var(--fw-white)}
.fw-entries{list-style:none;padding:0;margin:16px 0 0;display:grid;gap:10px}
.fw-entry{display:flex;align-items:center;gap:14px;min-height:76px;padding:12px 16px;border-radius:14px;background:var(--fw-white);border:2px solid var(--fw-line);color:var(--fw-ink);text-decoration:none}
.fw-entry:active,.fw-entry:hover{border-color:var(--fw-teal)}
.fw-entry-num{flex:none;width:44px;height:44px;border-radius:50%;background:var(--fw-teal);color:var(--fw-white);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px}
.fw-entry-text{display:flex;flex-direction:column}
.fw-entry-title{font-weight:800;font-size:20px;color:var(--fw-navy)}
.fw-entry-desc{font-size:15px;color:var(--fw-muted)}
.fw-hits{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.fw-hit,.fw-record{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:14px;background:var(--fw-white);border:2px solid var(--fw-line);color:var(--fw-ink);text-decoration:none}
a.fw-hit:hover,a.fw-hit:active{border-color:var(--fw-teal)}
.fw-hit.is-disabled{opacity:.75}
.fw-hit-title{font-weight:800;font-size:19px;color:var(--fw-navy)}
.fw-hit-meta{display:flex;gap:6px;flex-wrap:wrap;margin:0}
.fw-hit-summary{font-size:16px;color:var(--fw-muted)}
.fw-badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:14px;font-weight:700;line-height:1.6;border:1px solid transparent}
.fw-badge-navy{background:#e4eaf3;color:var(--fw-navy)}
.fw-badge-teal{background:var(--fw-teal-weak);color:var(--fw-teal-dark)}
.fw-badge-gold{background:var(--fw-gold-weak);color:var(--fw-gold-ink);border-color:#e6d28f}
.fw-badge-danger{background:var(--fw-danger-weak);color:var(--fw-danger)}
.fw-badge-ok{background:var(--fw-ok-weak);color:var(--fw-ok)}
.fw-badge-muted{background:#eef1f5;color:var(--fw-muted)}
.fw-status-badge{font-size:16px;padding:4px 12px}
.fw-steps{margin:0;padding-left:28px}
.fw-step{padding:10px 0;border-bottom:1px solid var(--fw-line);font-size:18px}
.fw-step:last-child{border-bottom:0}
.fw-step .fw-badge{margin-right:8px}
.fw-step.is-critical .fw-step-text{font-weight:700}
.fw-step-done{display:block;color:var(--fw-ok);font-weight:700;font-size:15px;margin-top:4px}
.fw-step-open{display:block;color:var(--fw-muted);font-size:15px;margin-top:4px}
.fw-btn{display:inline-flex;align-items:center;justify-content:center;min-height:56px;padding:10px 18px;border-radius:12px;border:2px solid transparent;font-weight:800;font-size:18px;text-decoration:none;cursor:pointer;text-align:center}
.fw-btn:disabled{opacity:.6;cursor:progress}
.fw-btn-primary{background:var(--fw-teal);color:var(--fw-white)}
.fw-btn-primary:hover{background:var(--fw-teal-dark)}
.fw-btn-secondary{background:var(--fw-white);color:var(--fw-navy);border-color:var(--fw-navy)}
.fw-btn-check{margin-top:8px;min-height:48px;background:var(--fw-white);color:var(--fw-teal-dark);border-color:var(--fw-teal)}
.fw-btn-choice{background:var(--fw-white);color:var(--fw-ink);border-color:var(--fw-navy);justify-content:flex-start;text-align:left;font-weight:700}
.fw-btn-block{display:flex;width:100%}
.fw-btn-block+.fw-btn-block,.fw-command-holder+.fw-btn,.fw-commands>*+*{margin-top:10px}
.fw-actions{display:flex;flex-direction:column;gap:10px}
.fw-actions .fw-btn{width:100%}
.fw-inline-error{margin:10px 0;padding:10px 12px;border-radius:10px;background:var(--fw-danger-weak);color:var(--fw-danger);font-weight:700}
.fw-warning{background:var(--fw-gold-weak);color:var(--fw-gold-ink);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-weight:700}
.fw-warning ul{margin:6px 0 0;padding-left:22px;font-weight:400}
.fw-command-form{background:#f7f9fc;border:1px solid var(--fw-line);border-radius:12px;padding:12px}
.fw-case-head{display:flex;gap:8px;flex-wrap:wrap}
.fw-dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;background:var(--fw-white);border:1px solid var(--fw-line);border-radius:14px;padding:14px 16px}
.fw-dl dt{font-weight:700;color:var(--fw-muted)}
.fw-dl dd{margin:0;word-break:break-word}
.fw-demo-hint{background:var(--fw-gold-weak);border:2px solid var(--fw-gold);border-radius:14px;padding:12px 14px;color:var(--fw-gold-ink)}
.fw-demo-hint p{margin:0 0 8px;font-weight:700}
.fw-timeline{list-style:none;margin:0;padding:0}
.fw-timeline li{display:flex;flex-wrap:wrap;gap:4px 10px;padding:8px 0;border-bottom:1px solid var(--fw-line)}
.fw-timeline li:last-child{border-bottom:0}
.fw-time{color:var(--fw-muted);font-variant-numeric:tabular-nums}
.fw-event{font-weight:800;color:var(--fw-navy)}
.fw-actor{color:var(--fw-teal-dark)}
.fw-event-detail{flex-basis:100%;font-size:16px;color:var(--fw-muted)}
.fw-json{white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.45;max-height:360px;overflow:auto;background:#0f1b2d;color:#e6edf6;border-radius:10px;padding:12px;margin-top:10px}
.fw-question{border:0;margin:0 0 16px;padding:0}
.fw-question legend{font-weight:800;font-size:18px;margin-bottom:8px;color:var(--fw-navy)}
.fw-choice{display:flex;align-items:flex-start;gap:10px;min-height:52px;padding:10px 12px;border:2px solid var(--fw-line);border-radius:12px;margin-top:8px;background:var(--fw-white);cursor:pointer}
.fw-choice input{width:24px;height:24px;margin-top:3px;flex:none;accent-color:var(--fw-teal)}
.fw-choice:has(input:checked){border-color:var(--fw-teal);background:var(--fw-teal-weak)}
.fw-results{padding-left:0;list-style:none}
.fw-results li{border-left:6px solid var(--fw-line);padding:6px 12px;margin:10px 0}
.fw-results li.is-correct{border-color:var(--fw-ok)}
.fw-results li.is-wrong{border-color:var(--fw-danger)}
.fw-results p{margin:4px 0}
.fw-feedback{border-radius:12px;padding:12px 14px}
.fw-feedback p{margin:4px 0}
.fw-feedback.is-correct{background:var(--fw-ok-weak);color:var(--fw-ok)}
.fw-feedback.is-wrong{background:var(--fw-danger-weak);color:var(--fw-danger)}
.fw-narrative{font-size:17px;background:#f7f9fc;border-radius:10px;padding:10px 12px}
.fw-failure{border-color:var(--fw-danger)}
.fw-bottom-nav{position:fixed;left:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(4,1fr);background:var(--fw-navy);border-top:3px solid var(--fw-gold);z-index:5}
.fw-bottom-nav a{color:var(--fw-white);text-decoration:none;text-align:center;font-weight:700;font-size:16px;min-height:60px;display:flex;align-items:center;justify-content:center}
.fw-footer{max-width:720px;margin:8px auto 0;padding:12px 16px 20px;font-size:15px;color:var(--fw-muted)}
.fw-toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);max-width:calc(100% - 32px);background:var(--fw-ok);color:var(--fw-white);padding:12px 16px;border-radius:12px;font-weight:700;opacity:0;pointer-events:none;transition:opacity .2s;z-index:6}
.fw-toast.is-visible{opacity:1}
@media (min-width:640px){.fw-actions{flex-direction:row}.fw-actions .fw-btn{width:auto;flex:1}}
@media (prefers-reduced-motion:reduce){.fw-toast{transition:none}}
`;
