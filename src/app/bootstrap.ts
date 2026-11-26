import { computeWarehouseAnalysis } from './core/stockEngine.ts';
import {
  curData,
  defaultWhData,
  getWhMeta,
  loadRegistry,
  pullSharedWarehouseState,
  saveRegistry,
} from './core/warehouseRegistry.ts';
import { closeCameraScanner } from './services/scannerService.ts';
import {
  ACTIVE_TAB_KEY,
  THEME_KEY,
  appState,
  registerAppRenderer,
  safeGet,
  sessionSetRaw,
} from './state/store.ts';
import { initAppAuthGate } from './ui/authGate.ts';
import { closeBulkTxModal } from './ui/bulkTxModal.ts';
import { renderChrome } from './ui/chrome.ts';
import {
  applyTheme,
  closeConfirm,
  closeDetailModal,
  closeMobileDrawer,
  closeTextModal,
  cycleTheme,
  showToast,
} from './ui/feedback.ts';
import {
  closeRoleModal,
  enforceRoleRouteGuard,
  getEffectiveRole,
  getSelectableWarehouses,
  openRoleModal,
} from './ui/rbac.ts';
import { renderKelolaGudang, renderMasterImpor, renderPengaturan } from './views/adminViews.ts';
import { renderCycleCount } from './views/cycleCountView.ts';
import { renderDashboard } from './views/dashboardView.ts';
import { renderDefect, renderExpire } from './views/defectExpireView.ts';
import { renderInbound } from './views/inboundView.ts';
import { renderAnalitik, renderCekData, renderSemuaGudang, renderStok } from './views/inventoryViews.ts';
import { renderKeluar } from './views/keluarView.ts';
import { renderMasuk } from './views/masukView.ts';
import { renderOpname } from './views/opnameView.ts';
import { renderPindah, renderTransfer } from './views/transferPindahView.ts';

type ViewRenderer = (root: HTMLElement, d: any, an: any) => void;

const VIEW_RENDERERS: Record<string, ViewRenderer> = {
  dashboard: (root, d, an) => renderDashboard(root, d, an),
  masuk: (root, d) => renderMasuk(root, d),
  inbound: (root, d, an) => renderInbound(root, d, an),
  keluar: (root, d, an) => renderKeluar(root, d, an),
  defect: (root, d, an) => renderDefect(root, d, an),
  expire: (root, d, an) => renderExpire(root, d, an),
  transfer: (root, d, an) => renderTransfer(root, d, an),
  pindah: (root, d, an) => renderPindah(root, d, an),
  opname: (root, d, an) => renderOpname(root, d, an),
  cyclecount: (root, d, an) => renderCycleCount(root, d, an),
  stok: (root, d, an) => renderStok(root, d, an),
  semua: (root) => renderSemuaGudang(root),
  analitik: (root, d, an) => renderAnalitik(root, d, an),
  cek: (root, d, an) => renderCekData(root, d, an),
  gudang: (root) => renderKelolaGudang(root),
  master: (root, d) => renderMasterImpor(root, d),
  pengaturan: (root, d) => renderPengaturan(root, d),
};

export function renderApp(): void {
  const role = enforceRoleRouteGuard();
  sessionSetRaw(ACTIVE_TAB_KEY, appState.currentTab);
  const options = getSelectableWarehouses();
  if (options.length && !options.some((warehouse) => warehouse.id === appState.W.cur)) {
    appState.W.cur = options[0].id;
    saveRegistry();
  }
  const d = options.length ? curData() : defaultWhData();
  const an = computeWarehouseAnalysis(d);
  renderChrome(an);

  const root = document.getElementById('view-root');
  if (!root) return;
  if (!options.length) {
    root.innerHTML =
      '<div class="empty-state"><h3>Gudang Stockkeeper belum tersedia</h3>' +
      '<p>Masuk dengan akun Stockkeeper yang sudah ditetapkan gudangnya. Jika sudah masuk, periksa penetapan gudang dengan Super Admin.</p></div>';
    return;
  }

  const renderer = VIEW_RENDERERS[appState.currentTab];
  if (renderer) renderer(root, d, an);
}

function captureInitialHtmlSnapshot(): void {
  try {
    const docClone = document.documentElement.cloneNode(true) as HTMLElement;
    docClone
      .querySelectorAll('script[src*="@vite"], script[src*="vite/client"], style[data-vite-dev-id]')
      .forEach((n) => {
        n.parentNode?.removeChild(n);
      });
    docClone.removeAttribute('data-theme');
    appState.initialHtmlSnapshot = '<!DOCTYPE html>\n' + docClone.outerHTML;
  } catch {
    appState.initialHtmlSnapshot = '';
  }
}

function bindGlobalControls(): void {
  document.getElementById('wh-switcher')?.addEventListener('change', (e) => {
    const role = getEffectiveRole();
    const val = (e.target as HTMLSelectElement).value;
    if (val === '__manage__' && role === 'super_admin') {
      appState.currentTab = 'gudang';
    } else if (getSelectableWarehouses().some((warehouse) => warehouse.id === val)) {
      appState.W.cur = val;
      appState.keluarEditId = '';
      appState.masukEditId = '';
      appState.scanPref.lastLoc = '';
      appState.lastRapidKeluarId = '';
      saveRegistry();
      showToast('Beralih ke ' + getWhMeta(appState.W.cur).nama);
    }
    renderApp();
  });

  document.getElementById('theme-toggle')?.addEventListener('click', cycleTheme);

  const cloudSyncBtn = document.getElementById('cloud-sync-btn');
  if (cloudSyncBtn) {
    cloudSyncBtn.addEventListener('click', () => {
      if (!appState.appAuthStatusCache.authenticated) return;
      void pullSharedWarehouseState('manual');
    });
  }

  document.getElementById('banner-backup-btn')?.addEventListener('click', () => {
    if (getEffectiveRole() === 'super_admin') {
      appState.settingsTab = 'master';
      appState.currentTab = 'pengaturan';
      renderApp();
    } else {
      openRoleModal('super_admin');
    }
  });

  document.getElementById('role-switch-btn')?.addEventListener('click', () => {
    void openRoleModal('');
  });
  document.getElementById('role-modal-close')?.addEventListener('click', closeRoleModal);
  document.getElementById('role-modal-cancel')?.addEventListener('click', closeRoleModal);
  document.getElementById('role-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeRoleModal();
  });

  document.getElementById('confirm-close')?.addEventListener('click', closeConfirm);
  document.getElementById('confirm-cancel')?.addEventListener('click', closeConfirm);
  document.getElementById('confirm-ok')?.addEventListener('click', () => {
    const fn = appState.confirmCb;
    closeConfirm();
    if (typeof fn === 'function') fn();
  });
  document.getElementById('confirm-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeConfirm();
  });

  document.getElementById('text-modal-close')?.addEventListener('click', closeTextModal);
  document.getElementById('text-modal-cancel')?.addEventListener('click', closeTextModal);
  document.getElementById('text-modal-action')?.addEventListener('click', () => {
    if (typeof appState.textModalActionCb === 'function') appState.textModalActionCb();
  });
  document.getElementById('text-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeTextModal();
  });

  document.getElementById('scan-modal-close')?.addEventListener('click', closeCameraScanner);
  document.getElementById('scan-modal-cancel')?.addEventListener('click', closeCameraScanner);
  document.getElementById('scan-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeCameraScanner();
  });

  document.getElementById('detail-modal-close')?.addEventListener('click', closeDetailModal);
  document.getElementById('detail-modal-cancel')?.addEventListener('click', closeDetailModal);
  document.getElementById('detail-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeDetailModal();
  });

  document.getElementById('drawer-close')?.addEventListener('click', closeMobileDrawer);
  document.getElementById('mobile-drawer')?.addEventListener('click', function (e) {
    if (e.target === this) closeMobileDrawer();
  });

  document.getElementById('bulk-tx-close')?.addEventListener('click', closeBulkTxModal);
  document.getElementById('bulk-tx-cancel')?.addEventListener('click', closeBulkTxModal);
  document.getElementById('bulk-tx-submit')?.addEventListener('click', () => {
    if (typeof appState.bulkTxSubmitCb === 'function') appState.bulkTxSubmitCb();
  });
  document.getElementById('bulk-tx-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeBulkTxModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeConfirm();
      closeTextModal();
      closeCameraScanner();
      closeDetailModal();
      closeMobileDrawer();
      closeRoleModal();
      closeBulkTxModal();
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = ((document.activeElement && document.activeElement.tagName) || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const searchInp = document.querySelector<HTMLInputElement>('#view-root input[type="search"]');
      if (searchInp) {
        e.preventDefault();
        searchInp.focus();
        searchInp.select();
      }
    }
  });
}

let booted = false;

export function bootWarehouseApp(): void {
  if (booted) return;
  booted = true;

  captureInitialHtmlSnapshot();
  appState.W = loadRegistry();
  registerAppRenderer(renderApp);
  bindGlobalControls();
  applyTheme(safeGet(THEME_KEY, 'auto'));

  try {
    renderApp();
  } catch (bootErr) {
    console.error(bootErr);
  }

  void initAppAuthGate(false);
}
