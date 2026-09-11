import { useEffect, useRef, useState, useCallback } from "react";
import {
  Camera,
  X,
  RefreshCw,
  Image as ImageIcon,
  AlertTriangle,
  Loader2,
  ClipboardPaste,
} from "lucide-react";
import jsQR from "jsqr";
import { decodeQrFromImageFile, decodeQrFromClipboard } from "../utils/qrDecoder";
import { useTranslation } from "../context/LanguageContext";

interface QrCameraScannerProps {
  isOpen: boolean;
  onScan: (decodedText: string) => void;
  onClose: () => void;
  title?: string;
}

export function QrCameraScanner({ isOpen, onScan, onClose, title }: QrCameraScannerProps) {
  const { t } = useTranslation();
  const displayTitle = title || t("qrScanTitle");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const camerasListRef = useRef<MediaDeviceInfo[]>([]);

  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  const isOpenRef = useRef(isOpen);
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);

  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [currentCameraIndex, setCurrentCameraIndex] = useState(0);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  const currentCameraIndexRef = useRef(currentCameraIndex);
  useEffect(() => { currentCameraIndexRef.current = currentCameraIndex; }, [currentCameraIndex]);

  const facingModeRef = useRef(facingMode);
  useEffect(() => { facingModeRef.current = facingMode; }, [facingMode]);

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* ignore */ }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startScanningLoop = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    let isScanning = true;

    const scanFrame = () => {
      if (!isScanning) return;
      if (!videoRef.current || !canvasRef.current) {
        animFrameRef.current = requestAnimationFrame(scanFrame);
        return;
      }

      const video = videoRef.current;
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
          });

          if (code && code.data && code.data.trim().length > 0) {
            isScanning = false;
            if (typeof navigator !== "undefined" && navigator.vibrate) {
              try { navigator.vibrate(80); } catch { /* ignore */ }
            }
            stopCamera();
            onScanRef.current(code.data);
            return;
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(scanFrame);
    };

    animFrameRef.current = requestAnimationFrame(scanFrame);
  }, [stopCamera]);

  const enumerateVideoDevices = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(
        (d) => d.kind === "videoinput" && d.deviceId && d.deviceId.trim().length > 0,
      );
      camerasListRef.current = videoDevices;
      setAvailableCameras((prev) => {
        if (prev.length !== videoDevices.length) return videoDevices;
        const hasDiff = videoDevices.some((d, idx) => d.deviceId !== prev[idx]?.deviceId);
        return hasDiff ? videoDevices : prev;
      });
      return videoDevices;
    } catch {
      return [];
    }
  }, []);

  const startCamera = useCallback(
    async (cameraIndex?: number, mode?: "environment" | "user") => {
      stopCamera();
      setIsLoading(true);
      setErrorMessage("");

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setIsLoading(false);
        setErrorMessage(t("qrNotSupported"));
        return;
      }

      const activeIndex = cameraIndex ?? currentCameraIndexRef.current;
      const activeMode = mode ?? facingModeRef.current;

      let stream: MediaStream | null = null;
      const knownDevices = camerasListRef.current;
      const targetDevice =
        knownDevices.length > 0 && knownDevices[activeIndex]?.deviceId
          ? knownDevices[activeIndex].deviceId
          : null;

      try {
        if (targetDevice && targetDevice.trim().length > 0) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { deviceId: { exact: targetDevice } },
            });
          } catch {
            stream = null;
          }
        }

        if (!stream) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode: { ideal: activeMode } },
            });
          } catch {
            stream = null;
          }
        }

        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true,
          });
        }

        if (!isOpenRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute("playsinline", "true");
          try {
            await videoRef.current.play();
          } catch (playErr) {
            console.warn("video.play() warning:", playErr);
          }
        }

        void enumerateVideoDevices();
        setIsLoading(false);
        startScanningLoop();
      } catch (err: unknown) {
        console.error("Camera start error:", err);
        setIsLoading(false);
        const name = (err as Error)?.name || "";
        const msg = (err as Error)?.message || String(err);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setErrorMessage(t("qrPermissionDenied"));
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          setErrorMessage(t("qrNoCameraFound"));
        } else {
          setErrorMessage(t("qrCameraFailed", { error: `${name || "Error"}: ${msg || "in use"}` }));
        }
      }
    },
    [stopCamera, enumerateVideoDevices, startScanningLoop, t],
  );

  const handleSwitchCamera = () => {
    if (availableCameras.length > 1) {
      setCurrentCameraIndex((prev) => (prev + 1) % availableCameras.length);
    } else {
      setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    setErrorMessage("");

    try {
      const decodedText = await decodeQrFromImageFile(file);
      stopCamera();
      onScanRef.current(decodedText);
    } catch {
      setErrorMessage(t("qrNoQrFound"));
    } finally {
      setIsProcessingFile(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handlePasteClipboard = async () => {
    setIsProcessingFile(true);
    setErrorMessage("");

    try {
      const decodedText = await decodeQrFromClipboard();
      stopCamera();
      onScanRef.current(decodedText);
    } catch {
      setErrorMessage(t("qrNoQrFound"));
    } finally {
      setIsProcessingFile(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void startCamera(currentCameraIndex, facingMode);
    } else {
      stopCamera();
    }
    return () => { stopCamera(); };
  }, [isOpen, currentCameraIndex, facingMode, startCamera, stopCamera]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => { stopCamera(); onClose(); }}>
      <section
        className="modal qr-scanner-modal"
        role="dialog"
        aria-modal="true"
        aria-label={displayTitle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header>
          <div className="qr-scanner-title">
            <Camera size={18} aria-hidden />
            <h2>{displayTitle}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => { stopCamera(); onClose(); }}
            aria-label={t("close")}
            title={t("close")}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        {/* Camera Viewfinder */}
        <div className="qr-camera">
          <video ref={videoRef} playsInline autoPlay muted className="qr-video" />
          <canvas ref={canvasRef} className="qr-canvas-hidden" />

          {/* Loading state */}
          {isLoading && !errorMessage && (
            <div className="qr-status">
              <Loader2 size={28} className="spin" aria-hidden />
              <p>{t("qrStarting")}</p>
            </div>
          )}

          {/* Processing image state */}
          {isProcessingFile && (
            <div className="qr-status">
              <Loader2 size={28} className="spin" aria-hidden />
              <p>{t("qrAnalyzing")}</p>
            </div>
          )}

          {/* Error */}
          {errorMessage && (
            <div className="qr-status qr-error">
              <AlertTriangle size={24} aria-hidden />
              <p>{errorMessage}</p>
              <div className="qr-error-actions">
                <button className="secondary-button" type="button" onClick={() => void startCamera()}>
                  {t("qrRetry")}
                </button>
                <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                  {t("qrUploadImage")}
                </button>
              </div>
            </div>
          )}

          {/* Overlay with corner brackets */}
          {!errorMessage && !isLoading && (
            <div className="qr-overlay">
              <div className="qr-frame">
                <div className="qr-corner tl" />
                <div className="qr-corner tr" />
                <div className="qr-corner bl" />
                <div className="qr-corner br" />
                <div className="qr-laser" />
              </div>
            </div>
          )}

          {/* Camera Switcher */}
          {(availableCameras.length > 1 || !errorMessage) && (
            <button
              className="icon-button qr-switch"
              type="button"
              onClick={handleSwitchCamera}
              title={t("qrSwitchCamera")}
              aria-label={t("qrSwitchCamera")}
            >
              <RefreshCw size={16} aria-hidden />
            </button>
          )}
        </div>

        {/* Bottom Actions */}
        <div className="qr-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="qr-canvas-hidden"
            onChange={handleFileChange}
          />
          <button
            className="secondary-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessingFile}
          >
            <ImageIcon size={16} aria-hidden />
            {t("qrUploadImage")}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={handlePasteClipboard}
            disabled={isProcessingFile}
          >
            <ClipboardPaste size={16} aria-hidden />
            {t("qrPasteClipboard")}
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => { stopCamera(); onClose(); }}
          >
            {t("cancel")}
          </button>
        </div>
      </section>
    </div>
  );
}
