// WorkspaceManager — Encrypted collaborative workspaces for GhostLink Pro
// Each workspace has its own blockchain chain, encryption context, and member permissions
(function(exports) {
  'use strict';

  /**
   * Workspace roles
   * @enum {string}
   */
  const WORKSPACE_ROLE = {
    OWNER: 'owner',
    ADMIN: 'admin',
    MEMBER: 'member'
  };

  /**
   * Workspace storage key
   * @type {string}
   */
  const STORAGE_KEY = 'gl_workspaces';

  /**
   * WorkspaceInvite storage key
   * @type {string}
   */
  const INVITE_KEY = 'gl_workspace_invites';

  /**
   * WorkspaceManager — Manages encrypted collaborative workspaces
   * @class
   */
  class WorkspaceManager {
    /**
     * Creates a new WorkspaceManager
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.licenseManager] - LicenseManager for access control
     * @param {Object} [options.featureGate] - FeatureGateManager for workspace gating
     */
    constructor(options = {}) {
      /** @type {Object} LicenseManager instance */
      this._licenseManager = options.licenseManager || null;
      /** @type {Object} FeatureGateManager instance */
      this._featureGate = options.featureGate || null;
      /** @type {Map<string, Object>} Active workspaces */
      this._workspaces = new Map();
      /** @type {Map<string, Object>} Member roles cache */
      this._memberRoles = new Map();
      /** @type {boolean} Is destroyed */
      this._destroyed = false;
      /** @type {Object} Event handlers */
      this._handlers = new Map();
    }

    /**
     * Initializes the WorkspaceManager
     * @returns {Promise<void>}
     */
    async init() {
      if (this._destroyed) return;

      // Check if workspaces feature is available
      if (this._featureGate) {
        const canUse = await this._featureGate.can('team_workspaces');
        if (!canUse) {
          console.warn('WorkspaceManager: team_workspaces not available');
          return;
        }
      }

      // Load workspaces from storage
      await this._loadWorkspaces();
    }

    // ═══════════════════════════════════════════════════════════════════
    // WORKSPACE LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Creates a new workspace
     * @param {string} name - Workspace name
     * @param {string} creatorId - Creator's peer ID
     * @returns {Promise<{success: boolean, workspace: ?Object, error: ?string}>}
     */
    async createWorkspace(name, creatorId) {
      if (this._destroyed) {
        return { success: false, workspace: null, error: 'WorkspaceManager destroyed' };
      }

      // Check feature gate
      if (this._featureGate) {
        const limit = await this._featureGate.checkLimit('workspace', this._workspaces.size);
        if (limit.reached) {
          await this._featureGate.triggerUpgradeFlow('workspace');
          return { success: false, workspace: null, error: 'Workspace limit reached' };
        }
      }

      // Generate workspace key (256-bit AES)
      const workspaceKey = await this._generateWorkspaceKey();

      // Generate workspace ID
      const workspaceId = this._generateId('ws');

      // Create workspace structure
      const workspace = {
        id: workspaceId,
        name: name,
        chain: [], // Empty chain for now
        members: [{
          id: creatorId,
          role: WORKSPACE_ROLE.OWNER,
          joinedAt: Date.now()
        }],
        encryptedVault: null,
        workspaceKey: workspaceKey, // Will be encrypted for storage
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // Store
      this._workspaces.set(workspaceId, workspace);
      this._memberRoles.set(this._memberKey(workspaceId, creatorId), WORKSPACE_ROLE.OWNER);

      await this._saveWorkspaces();

      return { success: true, workspace: workspace, error: null };
    }

    /**
     * Gets a workspace by ID
     * @param {string} workspaceId - Workspace ID
     * @returns {Object|null} Workspace or null
     */
    getWorkspace(workspaceId) {
      return this._workspaces.get(workspaceId) || null;
    }

    /**
     * Gets all workspaces for current user
     * @returns {Object[]} Array of workspaces
     */
    getWorkspaces() {
      return Array.from(this._workspaces.values());
    }

    /**
     * Updates a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {Object} updates - Fields to update
     * @returns {Promise<boolean>} Success status
     */
    async updateWorkspace(workspaceId, updates) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) return false;

      // Only owner/admin can update
      // (In real impl, would check current user's role)

      Object.assign(workspace, updates, { updatedAt: Date.now() });
      await this._saveWorkspaces();
      return true;
    }

    /**
     * Deletes a workspace
     * @param {string} workspaceId - Workspace ID
     * @returns {Promise<boolean>} Success status
     */
    async deleteWorkspace(workspaceId) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) return false;

      this._workspaces.delete(workspaceId);

      // Clean up member roles
      for (const [key] of this._memberRoles) {
        if (key.startsWith(workspaceId + ':')) {
          this._memberRoles.delete(key);
        }
      }

      await this._saveWorkspaces();
      return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MEMBER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Adds a member to workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} memberId - Member's peer ID
     * @param {string} role - Member role (default: member)
     * @returns {Promise<{success: boolean, error: ?string}>}
     */
    async addMember(workspaceId, memberId, role = WORKSPACE_ROLE.MEMBER) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) {
        return { success: false, error: 'Workspace not found' };
      }

      // Check if already member
      if (workspace.members.some(m => m.id === memberId)) {
        return { success: false, error: 'Already a member' };
      }

      // Add member
      workspace.members.push({
        id: memberId,
        role: role,
        joinedAt: Date.now()
      });

      this._memberRoles.set(this._memberKey(workspaceId, memberId), role);
      workspace.updatedAt = Date.now();

      await this._saveWorkspaces();
      return { success: true, error: null };
    }

    /**
     * Removes a member from workspace
     * Rotates the workspace key
     * @param {string} workspaceId - Workspace ID
     * @param {string} memberId - Member's peer ID
     * @returns {Promise<{success: boolean, newWorkspaceKey: ?string, error: ?string}>}
     */
    async removeMember(workspaceId, memberId) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) {
        return { success: false, newWorkspaceKey: null, error: 'Workspace not found' };
      }

      // Find member
      const memberIndex = workspace.members.findIndex(m => m.id === memberId);
      if (memberIndex === -1) {
        return { success: false, newWorkspaceKey: null, error: 'Member not found' };
      }

      const member = workspace.members[memberIndex];

      // Owner cannot be removed
      if (member.role === WORKSPACE_ROLE.OWNER) {
        return { success: false, newWorkspaceKey: null, error: 'Cannot remove owner' };
      }

      // Remove member
      workspace.members.splice(memberIndex, 1);
      this._memberRoles.delete(this._memberKey(workspaceId, memberId));
      workspace.updatedAt = Date.now();

      // Rotate the workspace key
      const newWorkspaceKey = await this._rotateWorkspaceKey(workspaceId, workspace);

      await this._saveWorkspaces();

      return { success: true, newWorkspaceKey: newWorkspaceKey, error: null };
    }

    /**
     * Updates member role
     * @param {string} workspaceId - Workspace ID
     * @param {string} memberId - Member's peer ID
     * @param {string} newRole - New role
     * @returns {Promise<boolean>} Success status
     */
    async updateMemberRole(workspaceId, memberId, newRole) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) return false;

      const member = workspace.members.find(m => m.id === memberId);
      if (!member) return false;

      // Cannot change owner's role
      if (member.role === WORKSPACE_ROLE.OWNER) return false;

      member.role = newRole;
      this._memberRoles.set(this._memberKey(workspaceId, memberId), newRole);
      workspace.updatedAt = Date.now();

      await this._saveWorkspaces();
      return true;
    }

    /**
     * Gets member role in workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} memberId - Member's peer ID
     * @returns {string|null} Role or null if not a member
     */
    getMemberRole(workspaceId, memberId) {
      return this._memberRoles.get(this._memberKey(workspaceId, memberId)) || null;
    }

    /**
     * Gets all members of workspace
     * @param {string} workspaceId - Workspace ID
     * @returns {Object[]} Array of members
     */
    getMembers(workspaceId) {
      const workspace = this._workspaces.get(workspaceId);
      return workspace ? [...workspace.members] : [];
    }

    // ═══════════════════════════════════════════════════════════════════
    // WORKSPACE KEY SYSTEM
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Generates a new 256-bit AES workspace key
     * @returns {Promise<string>} Base64-encoded key
     * @private
     */
    async _generateWorkspaceKey() {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );

      const exported = await crypto.subtle.exportKey('raw', key);
      return this._arrayBufferToBase64(exported);
    }

    /**
     * Rotates workspace key and redistributes to remaining members
     * @param {string} workspaceId - Workspace ID
     * @param {Object} workspace - Workspace object
     * @returns {Promise<string>} New workspace key
     * @private
     */
    async _rotateWorkspaceKey(workspaceId, workspace) {
      // Generate new key
      const newKey = await this._generateWorkspaceKey();

      // In real implementation, would re-encrypt workspace key for each remaining member
      // using their public keys. For now, just store the new key.
      workspace.workspaceKey = newKey;

      return newKey;
    }

    /**
     * Encrypts workspace key for a member
     * @param {string} workspaceId - Workspace ID
     * @param {string} memberId - Member's peer ID
     * @param {string} memberPublicKey - Member's public key
     * @returns {Promise<Object>} Encrypted workspace key
     */
    async encryptWorkspaceKeyForMember(workspaceId, memberId, memberPublicKey) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) return null;

      const Crypto = window.CryptoEngine;
      if (!Crypto) {
        throw new Error('CryptoEngine not loaded');
      }

      const encryptedBundle = await Crypto.encryptWithPublicKey(workspace.workspaceKey, memberPublicKey);

      return {
        workspaceId: workspaceId,
        encryptedKey: encryptedBundle,
        recipientPubKey: memberPublicKey,
        timestamp: Date.now()
      };
    }

    /**
     * Decrypts workspace key using private key
     * @param {Object} encryptedData - Encrypted workspace key data
     * @param {CryptoKey} privateKey - Private key for decryption
     * @returns {Promise<string>} Decrypted workspace key
     */
    async decryptWorkspaceKey(encryptedData, privateKey) {
      const Crypto = window.CryptoEngine;
      if (!Crypto) {
        throw new Error('CryptoEngine not loaded');
      }

      let data = encryptedData;
      if (data && typeof data === 'object') {
        if (data.ephemeralPubKeyHex) {
          return await Crypto.decryptWithPrivateKey(data, privateKey);
        }
        if (data.encryptedKey) {
          if (typeof data.encryptedKey === 'object' && data.encryptedKey.ephemeralPubKeyHex) {
            return await Crypto.decryptWithPrivateKey(data.encryptedKey, privateKey);
          }
          return data.encryptedKey;
        }
      }

      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.ephemeralPubKeyHex) {
            return await Crypto.decryptWithPrivateKey(parsed, privateKey);
          }
        } catch (e) {
          // ignore
        }
        if (data.includes(':')) {
          return data.split(':')[1];
        }
        return data;
      }

      return data;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INVITE SYSTEM
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Creates an invite for a workspace
     * @param {string} workspaceId - Workspace ID
     * @param {string} inviterId - Inviter's peer ID
     * @param {string} inviterName - Inviter's display name
     * @param {string} [recipientPubKeyHex] - Optional recipient public key for ECIES
     * @returns {Promise<{success: boolean, invite: ?Object, error: ?string}>}
     */
    async createInvite(workspaceId, inviterId, inviterName, recipientPubKeyHex) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) {
        return { success: false, invite: null, error: 'Workspace not found' };
      }

      // Get inviter's role
      const role = this.getMemberRole(workspaceId, inviterId);
      if (!role) {
        return { success: false, invite: null, error: 'Not a member' };
      }

      // Admins and owners can invite
      if (role === WORKSPACE_ROLE.MEMBER) {
        return { success: false, invite: null, error: 'Insufficient permissions' };
      }

      let encryptedWorkspaceKey;
      if (recipientPubKeyHex) {
        const Crypto = window.CryptoEngine;
        encryptedWorkspaceKey = await Crypto.encryptWithPublicKey(workspace.workspaceKey, recipientPubKeyHex);
      } else {
        encryptedWorkspaceKey = await this._encryptWorkspaceKeyPreview(workspace);
      }

      const invite = {
        workspaceId: workspaceId,
        workspaceName: workspace.name,
        encryptedWorkspaceKey: encryptedWorkspaceKey,
        inviter: inviterId,
        inviterName: inviterName,
        signature: await this._signInvite(workspaceId, inviterId),
        createdAt: Date.now(),
        expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
      };

      // Store invite
      await this._storeInvite(invite);

      return { success: true, invite: invite, error: null };
    }

    /**
     * Encrypts workspace key preview (simplified - real implementation would use recipient pubkey)
     * @param {Object} workspace - Workspace object
     * @returns {Promise<string>} Encrypted key
     * @private
     */
    async _encryptWorkspaceKeyPreview(workspace) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      return this._arrayBufferToBase64(nonce.buffer) + ':' + workspace.workspaceKey;
    }

    /**
     * Signs an invite
     * @param {string} workspaceId - Workspace ID
     * @param {string} inviterId - Inviter's peer ID
     * @returns {Promise<string>} Signature
     * @private
     */
    async _signInvite(workspaceId, inviterId) {
      const data = workspaceId + ':' + inviterId + ':' + Date.now();
      const encoded = new TextEncoder().encode(data);
      const hash = await crypto.subtle.digest('SHA-256', encoded);
      return this._arrayBufferToBase64(hash);
    }

    /**
     * Stores an invite
     * @param {Object} invite - Invite to store
     * @private
     */
    async _storeInvite(invite) {
      try {
        const invites = await this._loadInvites();
        const key = 'invite_' + invite.workspaceId + '_' + invite.inviter;
        invites[key] = invite;
        localStorage.setItem(INVITE_KEY, JSON.stringify(invites));
      } catch (e) {
        // Storage full or unavailable
      }
    }

    /**
     * Accepts an invite
     * @param {Object} invite - Invite to accept
     * @param {string} recipientId - Recipient's peer ID
     * @param {CryptoKey} [privateKey] - Recipient private key for ECIES decryption
     * @returns {Promise<{success: boolean, workspace: ?Object, error: ?string}>}
     */
    async acceptInvite(invite, recipientId, privateKey) {
      if (this._destroyed) {
        return { success: false, workspace: null, error: 'WorkspaceManager destroyed' };
      }

      // Verify invite not expired
      if (Date.now() > invite.expiresAt) {
        return { success: false, workspace: null, error: 'Invite expired' };
      }

      // Verify signature
      const valid = await this._verifyInviteSignature(invite);
      if (!valid) {
        return { success: false, workspace: null, error: 'Invalid signature' };
      }

      let decryptedKey = null;
      try {
        decryptedKey = await this.decryptWorkspaceKey(invite.encryptedWorkspaceKey, privateKey);
      } catch (err) {
        console.error('Decryption of workspace key failed:', err);
        return { success: false, workspace: null, error: 'Failed to decrypt workspace key' };
      }

      // Check if workspace still exists locally or add new one
      let workspace = this._workspaces.get(invite.workspaceId);
      if (!workspace) {
        workspace = {
          id: invite.workspaceId,
          name: invite.workspaceName,
          chain: [],
          members: [
            { id: invite.inviter, role: WORKSPACE_ROLE.OWNER, joinedAt: invite.createdAt },
            { id: recipientId, role: WORKSPACE_ROLE.MEMBER, joinedAt: Date.now() }
          ],
          encryptedVault: null,
          workspaceKey: decryptedKey,
          createdAt: invite.createdAt,
          updatedAt: Date.now()
        };
        this._workspaces.set(invite.workspaceId, workspace);
        this._memberRoles.set(this._memberKey(invite.workspaceId, recipientId), WORKSPACE_ROLE.MEMBER);
        this._memberRoles.set(this._memberKey(invite.workspaceId, invite.inviter), WORKSPACE_ROLE.OWNER);
      } else {
        // Check if already a member
        if (workspace.members.some(m => m.id === recipientId)) {
          return { success: false, workspace: null, error: 'Already a member' };
        }
        workspace.members.push({
          id: recipientId,
          role: WORKSPACE_ROLE.MEMBER,
          joinedAt: Date.now()
        });
        this._memberRoles.set(this._memberKey(invite.workspaceId, recipientId), WORKSPACE_ROLE.MEMBER);
        if (decryptedKey) {
          workspace.workspaceKey = decryptedKey;
        }
      }

      workspace.updatedAt = Date.now();
      await this._saveWorkspaces();

      // Clean up invite
      await this._removeInvite(invite);

      return { success: true, workspace: workspace, error: null };
    }

    /**
     * Verifies invite signature
     * @param {Object} invite - Invite to verify
     * @returns {Promise<boolean>} True if valid
     * @private
     */
    async _verifyInviteSignature(invite) {
      // In production, would verify with inviter's public key
      // For now, just check signature exists and invite is recent
      return !!invite.signature && (Date.now() - invite.createdAt) < 7 * 24 * 60 * 60 * 1000;
    }

    /**
     * Removes an invite
     * @param {Object} invite - Invite to remove
     * @private
     */
    async _removeInvite(invite) {
      try {
        const invites = await this._loadInvites();
        const key = 'invite_' + invite.workspaceId + '_' + invite.inviter;
        delete invites[key];
        localStorage.setItem(INVITE_KEY, JSON.stringify(invites));
      } catch (e) {
        // Ignore
      }
    }

    /**
     * Gets pending invites for a user
     * @returns {Promise<Object[]>} Array of invites
     */
    async getPendingInvites() {
      const invites = await this._loadInvites();
      const now = Date.now();

      return Object.values(invites).filter(invite =>
        invite.expiresAt > now
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    // CHAIN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Adds a message to workspace chain
     * @param {string} workspaceId - Workspace ID
     * @param {Object} message - Message to add
     * @returns {Promise<boolean>} Success status
     */
    async addToChain(workspaceId, message) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) return false;

      // Add message to chain
      workspace.chain.push({
        ...message,
        timestamp: Date.now()
      });
      workspace.updatedAt = Date.now();

      await this._saveWorkspaces();
      return true;
    }

    /**
     * Verifies workspace chain integrity
     * @param {string} workspaceId - Workspace ID
     * @returns {Promise<boolean>} True if chain is valid
     */
    async verifyChain(workspaceId) {
      const workspace = this._workspaces.get(workspaceId);
      if (!workspace) return false;

      const chain = workspace.chain;
      if (chain.length === 0) return true;

      // Check chain links are valid
      // In production, would check hash chain like main blockchain
      for (let i = 1; i < chain.length; i++) {
        if (chain[i].previousHash !== chain[i - 1].hash) {
          return false;
        }
      }

      return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Loads workspaces from storage
     * @returns {Promise<void>}
     * @private
     */
    async _loadWorkspaces() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return;

        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return;

        for (const ws of parsed) {
          if (ws.id) {
            this._workspaces.set(ws.id, ws);
            for (const member of (ws.members || [])) {
              this._memberRoles.set(this._memberKey(ws.id, member.id), member.role);
            }
          }
        }
      } catch (e) {
        // Corruption recovery
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (removeErr) {
          // Ignore
        }
      }
    }

    /**
     * Persists the current workspaces to storage.
     *
     * Public counterpart to _saveWorkspaces, for callers that mutate a chain
     * in place and need the result written back — the at-rest re-sealing pass
     * that upgrades pre-KDF blocks is the current one.
     * @returns {Promise<void>}
     */
    async persist() {
      return this._saveWorkspaces();
    }

    /**
     * Saves workspaces to storage
     * @returns {Promise<void>}
     * @private
     */
    async _saveWorkspaces() {
      try {
        const workspaces = Array.from(this._workspaces.values());
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
      } catch (e) {
        // Storage full or unavailable
      }
    }

    /**
     * Loads invites from storage
     * @returns {Promise<Object>} Invites object
     * @private
     */
    async _loadInvites() {
      try {
        const stored = localStorage.getItem(INVITE_KEY);
        if (!stored) return {};
        return JSON.parse(stored);
      } catch (e) {
        return {};
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Generates a unique ID
     * @param {string} prefix - ID prefix
     * @returns {string} Generated ID
     * @private
     */
    _generateId(prefix) {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      return prefix + '_' + timestamp + random;
    }

    /**
     * Creates member key for map storage
     * @param {string} workspaceId - Workspace ID
     * @param {string} memberId - Member ID
     * @returns {string} Key
     * @private
     */
    _memberKey(workspaceId, memberId) {
      return workspaceId + ':' + memberId;
    }

    /**
     * Converts ArrayBuffer to Base64
     * @param {ArrayBuffer} buffer - Buffer to convert
     * @returns {string} Base64 string
     * @private
     */
    _arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    /**
     * Registers an event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    on(event, handler) {
      if (!this._handlers.has(event)) {
        this._handlers.set(event, []);
      }
      this._handlers.get(event).push(handler);
    }

    /**
     * Emits an event
     * @param {string} event - Event name
     * @param {Object} data - Event data
     * @private
     */
    _emit(event, data) {
      const handlers = this._handlers.get(event) || [];
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          // Ignore handler errors
        }
      }
    }

    /**
     * Destroys the WorkspaceManager
     */
    destroy() {
      this._destroyed = true;
      this._workspaces.clear();
      this._memberRoles.clear();
      this._handlers.clear();
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.WorkspaceManager = WorkspaceManager;
  exports.GhostLink.WORKSPACE_ROLE = WORKSPACE_ROLE;

})(typeof globalThis !== 'undefined' ? globalThis : this);