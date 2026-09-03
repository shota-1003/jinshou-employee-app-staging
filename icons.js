'use strict';

// モダンな線画アイコンセット(絵文字を廃止し、Lucide風のシンプルなSVGへ統一するため新設)。
// 依存を増やさずCDN無しで完結させるため、必要なアイコンだけを軽量なインラインSVGとして自作している。
// 呼び出し側は icon('home') のようにHTML文字列を受け取って埋め込む。サイズ・色はCSS側
// (currentColorを継承、.icon{width;height} で調整)で統一する。
const ICON_PATHS = {
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9"/><path d="M10 20v-6h4v6"/>',
  'clipboard-list': '<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 10h6"/><path d="M9 13h6"/><path d="M9 16h4"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3.2-6 7-6s7 2.5 7 6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 15.2c2.4.4 4.5 2 4.5 4.8"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4.5-3 7.5-7 8.5-4-1-7-4-7-8.5V6l7-2.5Z"/><path d="M9.2 12.2 11 14l3.8-4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  receipt: '<path d="M6 3h12v18l-2.5-1.5L13 21l-1-1.5L11 21l-2.5-1.5L6 21V3Z"/><path d="M9 8h6"/><path d="M9 11.5h6"/><path d="M9 15h3.5"/>',
  'users-round': '<circle cx="8.5" cy="8" r="3"/><circle cx="16" cy="9.5" r="2.4"/><path d="M3 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M14.5 15.3c2.2.4 4 2 4 4.7"/>',
  package: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5"/><path d="M12 12v9"/>',
  'graduation-cap': '<path d="M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9Z"/><path d="M6.5 11v4.5c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3V11"/><path d="M21.5 9v6"/>',
  'message-circle': '<path d="M4 12a8 8 0 1 1 3.3 6.4L4 20l1.3-3.7A7.96 7.96 0 0 1 4 12Z"/>',
  building: '<rect x="5" y="3.5" width="10" height="17" rx="1"/><path d="M15 9h4v11.5"/><path d="M15 20.5V13"/><path d="M8 7h1M11 7h1M8 10.5h1M11 10.5h1M8 14h1M11 14h1"/>',
  'chevron-right': '<path d="m9.5 6 6.5 6-6.5 6"/>',
  'chevron-left': '<path d="m14.5 6-6.5 6 6.5 6"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5.2"/>',
  'alert-triangle': '<path d="M12 4 22 20H2L12 4Z"/><path d="M12 10.5v4"/><path d="M12 17.2v.1"/>',
  'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"/><circle cx="12" cy="12.5" r="3.5"/>',
  file: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/>',
  phone: '<path d="M6 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15.5 15.5 0 0 1 4.5 5.1 1.5 1.5 0 0 1 6 3.5Z"/>',
  'map-pin': '<path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
  edit: '<path d="M14.5 4.5 19 9 8 20H4v-4L14.5 4.5Z"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z"/>',
  'log-out': '<path d="M14 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h7"/><path d="M20 12H10"/><path d="m16.5 8 4 4-4 4"/>',
  mail: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="m4 6.5 8 6 8-6"/>',
  briefcase: '<rect x="3" y="7.5" width="18" height="12" rx="1.5"/><path d="M8.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 6v1.5"/><path d="M3 12.5h18"/>',
  hash: '<path d="M9 4 7 20M17 4l-2 16M4 9h16M3.3 15h16"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6v.1"/>',
  'sort-desc': '<path d="M6 5v13"/><path d="m3 15 3 3 3-3"/><path d="M12 6h8M12 11h5M12 16h3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  'heart-pulse': '<path d="M12 20s-7-4.4-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 5c-.6 1-1.3 2-2.2 3H16l-1.8-3-2 5-1.6-3H8.5"/>',
  'sparkles': '<path d="M12 3v3M12 18v3M4.5 5.5l2 2M17.5 16.5l2 2M3 12h3M18 12h3M4.5 18.5l2-2M17.5 7.5l2-2"/><circle cx="12" cy="12" r="3"/>',
  banknote: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  gift: '<path d="M20 12v8.5H4V12"/><rect x="2.5" y="7.5" width="19" height="4.5" rx="1"/><path d="M12 7.5v13"/><path d="M12 7.5S10.5 4 8.5 4a2 2 0 0 0 0 3.5H12Z"/><path d="M12 7.5S13.5 4 15.5 4a2 2 0 0 1 0 3.5H12Z"/>',
};

function icon(name, cls) {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg class="icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
