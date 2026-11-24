import { appState } from '../state/store.ts';
import { normBarcode } from '../utils/format.ts';

// === SUARA BEEP & KAMERA SCANNER HP/PDA ===




export function playBeep(ok = true) {
  if (!appState.soundEnabled) return;
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!appState.audioCtx) appState.audioCtx = new AC();
    if (appState.audioCtx.state === 'suspended') appState.audioCtx.resume();
    var now = appState.audioCtx.currentTime;
    var osc = appState.audioCtx.createOscillator();
    var gain = appState.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(appState.audioCtx.destination);
    if (ok) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1250, now);
      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
      osc.start(now);
      osc.stop(now + 0.12);
    } else {
      osc.type = 'square';
      osc.frequency.setValueAtTime(280, now);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch (e) {}
}




export function closeCameraScanner() {
  if (appState.activeScanRaf) {
    cancelAnimationFrame(appState.activeScanRaf);
    appState.activeScanRaf = 0;
  }
  if (appState.activeScanStream) {
    try {
      appState.activeScanStream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {}
    appState.activeScanStream = null;
  }
  appState.activeTorchOn = false;
  var v = document.getElementById('scan-video') as HTMLVideoElement | null;
  if (v) v.srcObject = null;
  var modal = document.getElementById('scan-modal');
  if (modal) modal.classList.remove('open');
}

export function openCameraScanner(onDetected: any, normalizeCode?: any) {
  var modal = document.getElementById('scan-modal');
  var statusEl = document.getElementById('scan-status');
  var videoEl = document.getElementById('scan-video') as HTMLVideoElement;
  var torchBtn = document.getElementById('scan-torch-btn');
  var wrapEl = document.getElementById('scan-video-wrap');

  torchBtn.style.display = 'none';
  wrapEl.style.display = 'block';
  statusEl.textContent = 'Membuka kamera belakang…';
  modal.classList.add('open');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    wrapEl.style.display = 'none';
    statusEl.textContent = 'Kamera tidak tersedia di peramban/halaman ini. Gunakan scanner PDA (keyboard wedge) atau ketik barcode langsung di kolom input.';
    return;
  }

  if (typeof window.BarcodeDetector === 'undefined') {
    wrapEl.style.display = 'none';
    statusEl.textContent = 'Peramban ini belum mendukung deteksi barcode kamera otomatis (gunakan Chrome Android terbaru atau langsung pindai dengan HP/PDA scanner ke kolom barcode).';
    return;
  }

  var detector = null;
  try {
    detector = new window.BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code']
    });
  } catch (e) {
    detector = new window.BarcodeDetector();
  }

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  }).then(function (stream) {
    appState.activeScanStream = stream;
    videoEl.srcObject = stream;
    videoEl.play().catch(function () {});
    statusEl.textContent = 'Arahkan kamera ke barcode…';

    var track = stream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function') {
      var caps = (track.getCapabilities() || {}) as Record<string, any>;
      if (caps && caps.torch) {
        torchBtn.style.display = 'inline-flex';
        torchBtn.textContent = 'Senter: Mati';
        torchBtn.onclick = function () {
          appState.activeTorchOn = !appState.activeTorchOn;
          track.applyConstraints({ advanced: [{ torch: appState.activeTorchOn } as any] }).then(function () {
            torchBtn.textContent = appState.activeTorchOn ? 'Senter: Nyala' : 'Senter: Mati';
          }).catch(function () {});
        };
      }
    }

    var scanning = false;
    function tick() {
      if (!appState.activeScanStream) return;
      if (!scanning && videoEl.readyState >= 2) {
        scanning = true;
        detector.detect(videoEl).then(function (codes) {
          scanning = false;
          if (!appState.activeScanStream) return;
          if (codes && codes.length > 0 && codes[0].rawValue) {
            var val = (normalizeCode || normBarcode)(codes[0].rawValue);
            closeCameraScanner();
            playBeep(true);
            if (typeof onDetected === 'function') onDetected(val);
            return;
          }
          appState.activeScanRaf = requestAnimationFrame(tick);
        }).catch(function () {
          scanning = false;
          if (appState.activeScanStream) appState.activeScanRaf = requestAnimationFrame(tick);
        });
      } else {
        appState.activeScanRaf = requestAnimationFrame(tick);
      }
    }
    appState.activeScanRaf = requestAnimationFrame(tick);
  }).catch(function () {
    wrapEl.style.display = 'none';
    statusEl.textContent = 'Izin kamera ditolak atau kamera sedang dipakai aplikasi lain. Anda tetap dapat memindai langsung dengan PDA scanner atau mengetik barcode.';
  });
}
