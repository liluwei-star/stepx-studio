/*
 * studio-adapt.js —— 官方 Studio 网页的手机排版适配
 * ================================================================
 *
 * 官方 studio.stepx.com 是按电脑屏幕设计的，在手机上直接打开会挤成一团。
 * 这个脚本注入一段 CSS，把主要容器改成适合窄屏的布局，
 * 同时保持官方弹窗、遮罩的原有层级关系不乱。
 *
 * 只在 studio.stepx.com 域名下生效，不碰其他网站。
 * 原有的英文注释：Mobile-only public DOM adaptation.
 * ================================================================
 */
// Mobile-only public DOM adaptation. Keep Studio's modal/backdrop semantics intact.
(()=>{if(location.origin!=='https://studio.stepx.com')return;let style=document.getElementById('stepx-studio-fit');if(!style){style=document.createElement('style');style.id='stepx-studio-fit';document.head.appendChild(style)}style.textContent='@media(max-width:600px){[data-slot="app-builder-root"][data-compact="true"][data-drawer-open="true"] section[aria-label="开发对话"][role="dialog"]{width:100%!important;max-width:100%!important}}';})();
