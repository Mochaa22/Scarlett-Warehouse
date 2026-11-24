import { curData, defaultWhData, getWhMeta } from '../core/warehouseRegistry.ts';
import { ROLE_LABELS, SECONDARY_TABS, appState, renderApp } from '../state/store.ts';
import { closeMobileDrawer, iconSvg, openMobileDrawer } from './feedback.ts';
import { enforceRoleRouteGuard, getNavGroupsForRole, getSelectableWarehouses, openRoleModal } from './rbac.ts';
import { esc } from '../utils/format.ts';

// === RENDER HEADER & NAVIGASI ===
export function renderChrome(analysis?: any) {
  var activeRole = enforceRoleRouteGuard();
  var options = getSelectableWarehouses(activeRole);
  var d = options.length ? curData() : defaultWhData();
  var activeWhName = options.length ? getWhMeta(appState.W.cur).nama : 'Gudang';
  var hdrTitleEl = document.getElementById('hdr-title');
  if (hdrTitleEl) {
    hdrTitleEl.textContent = activeWhName;
    hdrTitleEl.title = activeWhName;
  }
  document.getElementById('hdr-sub').textContent =
    ROLE_LABELS[activeRole] + ' · ' + (d.mode === 'all' ? 'ALL STOCK + Baru' : 'Mutasi') + ' · ' + appState.W.user;

  var roleBtnLbl = document.getElementById('role-switch-label');
  if (roleBtnLbl) roleBtnLbl.textContent = ROLE_LABELS[activeRole];

  var sel = document.getElementById('wh-switcher') as HTMLSelectElement;
  sel.style.display = options.length ? '' : 'none';
  sel.disabled = activeRole === 'stockkeeper' && options.length < 2;
  sel.innerHTML = options.map(function (w) {
    return '<option value="' + esc(w.id) + '"' + (w.id === appState.W.cur ? ' selected' : '') + '>' + esc(w.nama) + '</option>';
  }).join('') + (activeRole === 'super_admin' ? '<option value="__manage__">Kelola / tambah gudang…</option>' : '');

  function getNavBadgeHtml(itemId) {
    if ((itemId === 'masuk' || itemId === 'inbound') && activeRole !== 'stockkeeper' && analysis.stats.masukPending > 0) {
      return '<span class="nav-badge warn">' + analysis.stats.masukPending + '</span>';
    }
    if (itemId === 'keluar' && activeRole !== 'stockkeeper' && analysis.stats.keluarPending > 0) {
      return '<span class="nav-badge warn">' + analysis.stats.keluarPending + '</span>';
    }
    return '';
  }

  var roleGroups = getNavGroupsForRole(activeRole);
  var sideHtml = '';
  var drawerHtml = '';
  roleGroups.forEach(function (grp) {
    var itemsHtmlSide = '';
    var itemsHtmlDrawer = '';

    grp.items.forEach(function (item) {
      var badge = getNavBadgeHtml(item.id);
      var isPengaturanChild = item.id === 'pengaturan' && SECONDARY_TABS.has(appState.currentTab);
      var active = (appState.currentTab === item.id || isPengaturanChild) ? ' active' : '';
      var ico = iconSvg(item.id);
      itemsHtmlSide += '<button type="button" class="nav-item' + active + '" data-tab="' + item.id + '">' +
        '<span class="nav-item-main">' + ico + '<span class="nav-item-label">' + esc(item.label) + '</span></span>' + badge + '</button>';
      itemsHtmlDrawer += '<button type="button" class="drawer-item' + active + '" data-tab="' + item.id + '">' +
        '<span class="drawer-item-left">' + ico + '<span class="nav-item-label">' + esc(item.label) + '</span></span>' + badge + '</button>';
    });

    sideHtml += '<div class="nav-group"><div class="nav-group-title">' + esc(grp.title) + '</div>' + itemsHtmlSide + '</div>';
    drawerHtml += '<div class="nav-group-title" style="padding:0 2px 8px">' + esc(grp.title) + '</div><div class="drawer-grid">' + itemsHtmlDrawer + '</div>';
  });
  document.getElementById('sidebar-nav').innerHTML = sideHtml;
  if (activeRole === 'stockkeeper') {
    drawerHtml += '<div style="margin-top:12px"><button type="button" class="drawer-item" id="drawer-role-btn">' +
      '<span class="drawer-item-left">' + iconSvg('shield') + '<span class="nav-item-label">Ganti Role / PIN</span></span></button></div>';
  }
  document.getElementById('mobile-drawer-body').innerHTML = drawerHtml;

  var dockHtml = '';
  if (activeRole === 'stockkeeper') {
    var skDock = [
      { id: 'masuk', label: 'Masuk', icon: 'masuk' },
      { id: 'keluar', label: 'Keluar', icon: 'keluar' },
      { id: 'pindah', label: 'Pindah Rak', icon: 'pindah' },
      { id: 'stok', label: 'Stok Aktif', icon: 'stok' }
    ];
    dockHtml = skDock.map(function (t) {
      var act = appState.currentTab === t.id ? ' active' : '';
      return '<button type="button" class="dock-btn' + act + '" data-tab="' + t.id + '">' +
        iconSvg(t.icon) + '<span>' + esc(t.label) + '</span></button>';
    }).join('');
    var isSkOtherActive = !skDock.some(function (t) { return t.id === appState.currentTab; });
    dockHtml += '<button type="button" class="dock-btn' + (isSkOtherActive ? ' active' : '') + '" id="dock-menu-btn">' +
      iconSvg('menu') + '<span>Menu</span></button>';
  } else {
    var dockTabs = [
      { id: 'dashboard', label: 'Beranda', icon: 'dashboard', badgeCount: 0 },
      { id: 'masuk', label: 'Masuk', icon: 'masuk', badgeCount: 0 },
      { id: 'inbound', label: 'Surat Jalan', icon: 'inbound', badgeCount: Number(analysis.stats.masukPending || 0) },
      { id: 'keluar', label: 'Keluar', icon: 'keluar', badgeCount: Number(analysis.stats.keluarPending || 0) }
    ];
    dockHtml = dockTabs.map(function (t) {
      var act = appState.currentTab === t.id ? ' active' : '';
      return '<button type="button" class="dock-btn' + act + '" data-tab="' + t.id + '">' +
        iconSvg(t.icon) + '<span>' + esc(t.label) + '</span>' +
        (t.badgeCount > 0 ? '<span class="dock-dot">' + (t.badgeCount > 99 ? '99+' : t.badgeCount) + '</span>' : '') +
        '</button>';
    }).join('');
    var isOtherActive = !dockTabs.some(function (t) { return t.id === appState.currentTab; });
    dockHtml += '<button type="button" class="dock-btn' + (isOtherActive ? ' active' : '') + '" id="dock-menu-btn">' +
      iconSvg('menu') + '<span>Menu</span>' +
      '</button>';
  }
  document.getElementById('mobile-dock').innerHTML = dockHtml;

  document.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      appState.currentTab = btn.getAttribute('data-tab');
      closeMobileDrawer();
      renderApp();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  var menuBtn = document.getElementById('dock-menu-btn');
  if (menuBtn) {
    menuBtn.addEventListener('click', openMobileDrawer);
  }
  var drawerRoleBtn = document.getElementById('drawer-role-btn');
  if (drawerRoleBtn) {
    drawerRoleBtn.addEventListener('click', function () {
      closeMobileDrawer();
      openRoleModal('');
    });
  }
  var dockRoleBtn = document.getElementById('dock-role-btn');
  if (dockRoleBtn) {
    dockRoleBtn.addEventListener('click', function () { openRoleModal(''); });
  }
}
