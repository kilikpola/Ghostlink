// LicenseManager — Manages GhostLink license lifecycle
(function(exports) {
  'use strict';

  const STORAGE_KEY = 'gl_license';
  const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

  const Core = () => exports.GhostLink?.LicenseCore;

  const ERROR_LABELS = {
    invalid_format: 'Invalid license key format',
    invalid_checksum: 'License checksum verification failed',
    invalid_signature: 'License signature verification failed',
    expired: 'This license has expired',
    device_mismatch: 'This license is bound to a different Device ID',
    malformed_payload: 'Malformed license key',
    unsupported_version: 'Unsupported license version — request a new key',
    invalid_duration: 'Invalid license duration',
    tampering_detected: 'License tampering detected',
    DEVICE_MISMATCH: 'This license is bound to a different Device ID',
  };

  class LicenseManager {
    constructor(options = {}) {
      this._validator = options.validator || null;
      this._deviceFP = options.deviceFingerprint || null;
      this._cachedLicense = null;
      this._cachedAt = null;
      this._destroyed = false;
    }

    async init() {
      if (this._destroyed) return;
      if (this._validator && this._deviceFP) {
        this._validator.setDeviceFingerprint(this._deviceFP);
      }
      await this._loadCached();
    }

    formatError(code) {
      return ERROR_LABELS[code] || code || 'Activation failed';
    }

    async activate(licenseKey) {
      if (this._destroyed) {
        return { success: false, error: 'LicenseManager destroyed', license: null };
      }
      if (!this._validator) {
        return { success: false, error: 'No validator configured', license: null };
      }

      const core = Core();
      const activatedAt = Date.now();

      const validation = await this._validator.validate(licenseKey, {
        skipDeviceCheck: false,
        activatedAt,
      });

      if (!validation.valid) {
        return {
          success: false,
          error: this.formatError(validation.error),
          errorCode: validation.error,
          license: null,
        };
      }

      const expiresAt = core
        ? core.computeExpiryTimestamp(activatedAt, validation.license.durationMonths)
        : activatedAt;

      const storedLicense = {
        key: licenseKey.trim().toUpperCase(),
        tier: validation.license.tier,
        durationMonths: validation.license.durationMonths,
        activatedAt,
        expiresAt,
        fingerprint: validation.license.deviceFingerprint || null,
        maxUsers: validation.license.maxUsers || null,
        version: validation.license.version,
      };

      if (!this._saveLicense(storedLicense)) {
        return { success: false, error: 'Storage save failed', license: null };
      }

      this._cachedLicense = storedLicense;
      this._cachedAt = Date.now();
      return { success: true, error: null, license: storedLicense };
    }

    deactivate() {
      if (this._destroyed) return false;
      try {
        localStorage.removeItem(STORAGE_KEY);
        this._cachedLicense = null;
        this._cachedAt = null;
        return true;
      } catch (e) {
        return false;
      }
    }

    async getActiveLicense() {
      if (this._destroyed) return null;
      if (this._cachedLicense && this._cachedAt && (Date.now() - this._cachedAt) < 60000) {
        return this._cachedLicense;
      }
      await this._loadCached();
      return this._cachedLicense;
    }

    async isGracePeriod() {
      const license = await this.getActiveLicense();
      if (!license || !license.expiresAt) return false;
      const now = Date.now();
      if (now <= license.expiresAt) return false;
      return now < license.expiresAt + GRACE_PERIOD_MS;
    }

    async getGracePeriodEnd() {
      const license = await this.getActiveLicense();
      if (!license?.expiresAt) return null;
      return license.expiresAt + GRACE_PERIOD_MS;
    }

    async isActive() {
      if (this._destroyed) return false;
      const license = await this.getActiveLicense();
      if (!license?.expiresAt) return false;
      if (Date.now() <= license.expiresAt) return true;
      return this.isGracePeriod();
    }

    async isExpired() {
      const license = await this.getActiveLicense();
      if (!license?.expiresAt) return false;
      return Date.now() > license.expiresAt && !(await this.isGracePeriod());
    }

    async getTier() {
      if (this._destroyed) return 'free';
      const license = await this.getActiveLicense();
      if (!license) return 'free';
      if (Date.now() > license.expiresAt) {
        return (await this.isGracePeriod()) ? license.tier : 'free';
      }
      return license.tier;
    }

    async getDaysRemaining() {
      const license = await this.getActiveLicense();
      if (!license?.expiresAt) return 0;
      const remaining = license.expiresAt - Date.now();
      if (remaining <= 0) return 0;
      return Math.ceil(remaining / (24 * 60 * 60 * 1000));
    }

    async _loadCached() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) {
          this._cachedLicense = null;
          this._cachedAt = null;
          return;
        }
        const parsed = JSON.parse(stored);
        if (!this._validateStoredStructure(parsed)) {
          localStorage.removeItem(STORAGE_KEY);
          this._cachedLicense = null;
          this._cachedAt = null;
          return;
        }
        // The stored record is only a cache: re-verify the key and take tier
        // and expiry from it, never from what localStorage says.
        const verified = await this._reverify(parsed);
        if (!verified) {
          localStorage.removeItem(STORAGE_KEY);
          this._cachedLicense = null;
          this._cachedAt = null;
          return;
        }
        this._cachedLicense = verified;
        this._cachedAt = Date.now();
      } catch (e) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        this._cachedLicense = null;
        this._cachedAt = null;
      }
    }

    async _reverify(stored) {
      const core = Core();
      if (!this._validator || !core) return null;
      // skipDeviceCheck is false: a stored license copied from another device
      // is exactly what the device binding exists to refuse. Expiry is not
      // checked here — an expired license still has to reach getTier() so the
      // grace period can apply.
      const result = await this._validator.validate(stored.key, { skipDeviceCheck: false });
      if (!result.valid) return null;
      const license = result.license;
      return {
        ...stored,
        tier: license.tier,
        durationMonths: license.durationMonths,
        expiresAt: core.computeExpiryTimestamp(stored.activatedAt, license.durationMonths),
        maxUsers: license.maxUsers || null,
        version: license.version,
      };
    }

    _validateStoredStructure(license) {
      if (!license || typeof license !== 'object') return false;
      const required = ['key', 'tier', 'activatedAt', 'expiresAt'];
      for (const field of required) {
        if (!(field in license)) return false;
      }
      if (typeof license.key !== 'string') return false;
      if (typeof license.tier !== 'string') return false;
      if (typeof license.activatedAt !== 'number') return false;
      if (typeof license.expiresAt !== 'number') return false;
      if (license.activatedAt > Date.now() + 60000) return false;
      if (license.expiresAt < 0) return false;
      return true;
    }

    _saveLicense(license) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(license));
        return true;
      } catch (e) {
        return false;
      }
    }

    destroy() {
      this._destroyed = true;
      this._cachedLicense = null;
      this._cachedAt = null;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.LicenseManager = LicenseManager;
  exports.GhostLink.GRACE_PERIOD_MS = GRACE_PERIOD_MS;

})(typeof globalThis !== 'undefined' ? globalThis : this);
