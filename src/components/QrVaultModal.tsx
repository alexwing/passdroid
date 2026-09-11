import { useState } from "react";
import { Copy, QrCode, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useTranslation } from "../context/LanguageContext";
import type { SyncConfig } from "../api";

interface QrVaultModalProps {
  isOpen: boolean;
  syncConfig: SyncConfig;
  onClose: () => void;
}

interface QrPayload {
  type: "passdroid-vault-link";
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  remoteFile: string;
}

export function encodeQrPayload(config: SyncConfig): string {
  const payload: QrPayload = {
    type: "passdroid-vault-link",
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    remoteDir: config.remoteDir,
    remoteFile: config.remoteFile,
  };
  return `pdvault://${btoa(JSON.stringify(payload))}`;
}

export function parseQrPayload(text: string): SyncConfig | null {
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith("pdvault://")) {
      jsonStr = atob(jsonStr.replace("pdvault://", ""));
    }
    const data = JSON.parse(jsonStr);
    if (data.type !== "passdroid-vault-link" || !data.host) return null;
    return {
      enabled: true,
      protocol: data.protocol || "ftp",
      host: data.host,
      port: data.port || 21,
      username: data.username || "",
      password: data.password || "",
      remoteDir: data.remoteDir || "vault",
      remoteFile: data.remoteFile || "passdroid.pdvault",
    };
  } catch {
    return null;
  }
}

export function QrVaultModal({ isOpen, syncConfig, onClose }: QrVaultModalProps) {
  const { t } = useTranslation();
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generateQr = async () => {
    const encoded = encodeQrPayload(syncConfig);
    const url = await QRCode.toDataURL(encoded, {
      width: 280,
      margin: 2,
      color: {
        dark: "#17211f",
        light: "#ffffff",
      },
    });
    setQrUrl(url);
  };

  // Generate QR on open
  if (isOpen && !qrUrl) {
    void generateQr();
  }

  const handleCopyConfig = async () => {
    const encoded = encodeQrPayload(syncConfig);
    await navigator.clipboard.writeText(encoded);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setQrUrl(null);
    setCopied(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleClose}>
      <section
        className="modal qr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("qrLinkDevice")}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{t("qrLinkDevice")}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={handleClose}
            aria-label={t("close")}
            title={t("close")}
          >
            <span aria-hidden>✕</span>
          </button>
        </header>

        {/* QR Code Image */}
        <div className="qr-image-container">
          {qrUrl ? (
            <img src={qrUrl} alt="QR Code" className="qr-image" />
          ) : (
            <div className="qr-placeholder">
              <QrCode size={48} aria-hidden />
            </div>
          )}
        </div>

        {/* Info box */}
        <div className="qr-info">
          <h3>{t("qrHowTitle")}</h3>
          <p>{t("qrHowBody")}</p>
          <div className="qr-security-note">
            <ShieldCheck size={18} aria-hidden />
            <p>{t("qrSecurityNote")}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="qr-modal-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={handleCopyConfig}
          >
            <Copy size={16} aria-hidden />
            {copied ? "✓" : t("qrCopyConfig")}
          </button>
          <button className="ghost-button" type="button" onClick={handleClose}>
            {t("close")}
          </button>
        </div>
      </section>
    </div>
  );
}
