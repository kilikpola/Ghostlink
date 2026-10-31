(function(exports) {
  'use strict';

  const { useState, useEffect, useRef } = React;

  // Reusable Icon component matching index.html
  const I = ({ t, s = 20, c }) => {
    const p = { width: s, height: s, display: "inline-block", verticalAlign: "middle" };
    // Get original icons from main app window if available, or define fallback
    if (window.I) {
      return React.createElement(window.I, { t, s, c });
    }
    const m = {
      ghost: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M12 2C7.58 2 4 5.58 4 10v10.5c0 .83 1 1.5 1.5 1.5s1-.67 1.5-1.5c.5-.83 1-1.5 1.5-1.5s1 .67 1.5 1.5c.5.83 1 1.5 1.5 1.5s1-.67 1.5-1.5c.5-.83 1-1.5 1.5-1.5s1 .67 1.5 1.5c.5.83 1 1.5 1.5 1.5s1.5-.67 1.5-1.5V10c0-4.42-3.58-8-8-8z" }),
        React.createElement("circle", { cx: "9", cy: "10", r: "1.5", fill: c || "currentColor" }),
        React.createElement("circle", { cx: "15", cy: "10", r: "1.5", fill: c || "currentColor" })
      ),
      lock: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "1.5" },
        React.createElement("rect", { x: "3", y: "11", width: "18", height: "11", rx: "2" }),
        React.createElement("path", { d: "M7 11V7a5 5 0 0110 0v4" })
      ),
      link: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" }),
        React.createElement("path", { d: "M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" })
      ),
      users: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" }),
        React.createElement("circle", { cx: "9", cy: "7", r: "4" }),
        React.createElement("path", { d: "M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" })
      ),
      plus: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "2" },
        React.createElement("line", { x1: "12", y1: "5", x2: "12", y2: "19" }),
        React.createElement("line", { x1: "5", y1: "12", x2: "19", y2: "12" })
      ),
      x: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "2" },
        React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
        React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
      ),
      check: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "#00ffa3", strokeWidth: "2" },
        React.createElement("path", { d: "M20 6L9 17l-5-5" })
      ),
      trash: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "1.5" },
        React.createElement("polyline", { points: "3,6 5,6 21,6" }),
        React.createElement("path", { d: "M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" })
      ),
      export: React.createElement("svg", { style: p, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" }),
        React.createElement("polyline", { points: "17,8 12,3 7,8" }),
        React.createElement("line", { x1: "12", y1: "3", x2: "12", y2: "15" })
      ),
    };
    return m[t] || m.ghost;
  };

  // Tag helper matching index.html
  const Tag = ({ color, children, icon }) => (
    React.createElement("span", {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "2px 8px",
        borderRadius: 6,
        background: `${color}15`,
        color: color,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.5,
        border: `1px solid ${color}20`
      }
    },
      icon && React.createElement(I, { t: icon, s: 10, c: color }),
      children
    )
  );

  // Button helper matching index.html
  const Btn = ({ children, onClick, style, ghost, small, accent, ...rest }) => (
    React.createElement("button", {
      onClick: onClick,
      style: {
        background: ghost ? "transparent" : accent ? `linear-gradient(135deg, var(--th-accent, #00ffa3), var(--th-accent2, #00d4ff))` : "rgba(255,255,255,0.04)",
        border: ghost ? `1px solid rgba(255,255,255,0.08)` : accent ? "none" : "1px solid rgba(255,255,255,0.06)",
        borderRadius: small ? 8 : 10,
        padding: small ? "6px 10px" : "10px 16px",
        color: accent ? "#000" : ghost ? "#8a8a9a" : "#c0c0c8",
        cursor: "pointer",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        transition: "all 0.2s ease",
        letterSpacing: 0.5,
        outline: "none",
        ...style,
      },
      ...rest
    }, children)
  );

  // ═══════════════════════════════════════════════════════════════════
  // 1. PRO UPGRADE MODAL
  // ═══════════════════════════════════════════════════════════════════
  const UpgradeModal = ({ show, onClose, limitType, deviceId, licenseKeyInput, setLicenseKeyInput, licenseError, setLicenseError, licenseActivating, onActivate, th }) => {
    if (!show) return null;

    const featureDetails = {
      pro_themes: {
        title: "Stealth & Carbon Themes",
        desc: "Unlock premium workspace interfaces designed for high stealth and gold aesthetics."
      },
      transfer: {
        title: "Large File Transfer",
        desc: "Send files up to 2GB. Free tier is capped at 25MB per file."
      },
      peers: {
        title: "Unlimited Peer Connections",
        desc: "Establish more than 5 simultaneous WebRTC channels. Free tier is limited to 5 active peers."
      },
      export: {
        title: "Full Hash-Chain History Export",
        desc: "Export the complete hash chains for verification. Free tier limits exports to the last 500 blocks."
      },
      team_workspaces: {
        title: "Collaborative Team Workspaces",
        desc: "Unlock complete workspaces with separate hash chains, invite templates, ECIES encryption, and member rotations."
      }
    };

    const details = featureDetails[limitType] || {
      title: "Premium Feature Locked",
      desc: "This feature requires a GhostLink Pro/Team license to access."
    };

    return React.createElement("div", {
      className: "glass-overlay",
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999,
        padding: 16
      },
      onClick: onClose
    },
      React.createElement("div", {
        style: {
          background: "#0c0c12",
          border: `1px solid ${th.accent}20`,
          borderRadius: 20,
          padding: 28,
          maxWidth: 480,
          width: "100%",
          boxShadow: `0 30px 80px rgba(0,0,0,0.8), 0 0 50px ${th.accent}0a`,
          animation: "fadeInScale 0.25s cubic-bezier(0.16, 1, 0.3, 1)"
        },
        onClick: e => e.stopPropagation()
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 } },
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            React.createElement(I, { t: "lock", s: 20, c: th.accent }),
            React.createElement("span", { style: { fontSize: 16, fontWeight: 800, letterSpacing: 1.5, color: "#fff" } }, "GHOSTLINK PRO")
          ),
          React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", color: "#4a5568", cursor: "pointer" } },
            React.createElement(I, { t: "x", s: 18 })
          )
        ),

        React.createElement("div", { style: { background: `${th.accent}08`, border: `1px solid ${th.accent}15`, borderRadius: 12, padding: 16, marginBottom: 20 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: th.accent, marginBottom: 4 } }, details.title),
          React.createElement("div", { style: { fontSize: 11.5, color: "#8a8a9a", lineHeight: 1.5 } }, details.desc)
        ),

        React.createElement("div", { style: { marginBottom: 20 } },
          React.createElement("div", { style: { fontSize: 9.5, color: "#4a5568", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 } }, "Your Device Fingerprint (Required for Pro keys)"),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("div", {
              style: {
                flex: 1,
                fontFamily: "monospace",
                fontSize: 10,
                color: "#64748b",
                background: "rgba(255,255,255,0.02)",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.04)",
                wordBreak: "break-all"
              }
            }, deviceId || "Loading fingerprint..."),
            React.createElement(Btn, {
              small: true,
              onClick: () => {
                navigator.clipboard.writeText(deviceId);
                if (window.addToast) window.addToast("Device ID copied", "success");
              }
            }, "Copy")
          )
        ),

        React.createElement("div", { style: { marginBottom: 20 } },
          React.createElement("div", { style: { fontSize: 9.5, color: "#4a5568", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 } }, "Enter License Key"),
          React.createElement("input", {
            type: "text",
            placeholder: "GHOST-XXXX-XXXX-XXXX-XXXX-XXXX",
            value: licenseKeyInput,
            onChange: e => { setLicenseKeyInput(e.target.value.toUpperCase()); setLicenseError(null); },
            style: {
              width: "100%",
              padding: "12px",
              background: "#06060a",
              border: licenseError ? "1px solid #ff4466" : "1px solid rgba(255,255,255,0.06)",
              borderRadius: 10,
              color: "#fff",
              fontSize: 13,
              fontFamily: "monospace",
              boxSizing: "border-box",
              marginBottom: 8,
              outline: "none"
            }
          }),
          licenseError && React.createElement("div", { style: { fontSize: 10.5, color: "#ff4466", marginBottom: 8 } }, licenseError)
        ),

        React.createElement(Btn, {
          accent: true,
          style: { width: "100%", padding: "12px 0" },
          onClick: onActivate,
          disabled: licenseActivating
        }, licenseActivating ? "Verifying..." : "Activate Pro Features"),

        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18, fontSize: 9.5, color: "#4a5568" } },
          React.createElement("span", null, "Offline validation engine active"),
          React.createElement("a", {
            href: `mailto:ghostlink@proton.me?subject=GhostLink%20License%20Request&body=Plan:%20Pro%0ADevice%20ID:%20${encodeURIComponent(deviceId)}`,
            style: { color: th.accent, textDecoration: "underline" }
          }, "Request key via Email")
        )
      )
    );
  };

  // ═══════════════════════════════════════════════════════════════════
  // 2. WORKSPACE LIST COLUMN (Middle column)
  // ═══════════════════════════════════════════════════════════════════
  const WorkspacePanel = ({ workspaces, activeConvo, setActiveConvo, setWorkspaces, onCreateClick, onJoinClick, th }) => {
    return React.createElement("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" } },
      React.createElement("div", { style: { padding: "16px 14px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "space-between" } },
        React.createElement("div", null,
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, letterSpacing: 1.5 } }, "WORKSPACES"),
          React.createElement("div", { style: { fontSize: 9, color: "#4a5568", marginTop: 2 } }, "Decentralized Teams")
        ),
        React.createElement("div", { style: { display: "flex", gap: 6 } },
          React.createElement(Btn, { small: true, onClick: onJoinClick }, "Join"),
          React.createElement(Btn, { small: true, accent: true, onClick: onCreateClick }, "+ New")
        )
      ),

      React.createElement("div", { style: { flex: 1, overflowY: "auto", padding: "6px 0" } },
        workspaces.length === 0 ? React.createElement("div", { style: { textAlign: "center", padding: "40px 20px", color: "#2a2a3a" } },
          React.createElement(I, { t: "users", s: 32, c: "#161626" }),
          React.createElement("div", { style: { marginTop: 12, fontSize: 12, fontWeight: 600, color: "#3a3a4a" } }, "No workspaces yet"),
          React.createElement("div", { style: { marginTop: 6, fontSize: 10, color: "#272737", lineHeight: 1.6 } }, "Create a workspace to host secure collaborative channels, or paste a member's invite to join."),
          React.createElement("div", { style: { display: "flex", justifyContent: "center", gap: 10, marginTop: 14 } },
            React.createElement(Btn, { small: true, onClick: onJoinClick }, "Paste Invite"),
            React.createElement(Btn, { small: true, accent: true, onClick: onCreateClick }, "Create Workspace")
          )
        ) : workspaces.map(ws => (
          React.createElement("div", {
            key: ws.id,
            onClick: () => {
              setActiveConvo(ws.id);
              setWorkspaces(prev => prev.map(w => w.id === ws.id ? { ...w, unread: 0 } : w));
            },
            style: {
              padding: "12px 14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 11,
              background: activeConvo === ws.id ? `${th.accent}08` : "transparent",
              borderLeft: activeConvo === ws.id ? `2px solid ${th.accent}` : "2px solid transparent",
              transition: "all 0.15s ease",
            }
          },
            React.createElement("div", {
              style: {
                width: 38,
                height: 38,
                borderRadius: 10,
                background: `linear-gradient(135deg, ${th.accent3}30, ${th.accent2}10)`,
                border: `1px solid ${th.accent2}25`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 800,
                color: th.accent2,
                flexShrink: 0
              }
            }, ws.name.slice(0, 2).toUpperCase()),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
              React.createElement("div", { style: { fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 } },
                React.createElement("span", { style: { color: activeConvo === ws.id ? "#fff" : "#c0c0c8" } }, ws.name),
                ws.unread > 0 && React.createElement("span", {
                  style: {
                    padding: "2px 6px",
                    borderRadius: 6,
                    background: th.accent,
                    color: "#000",
                    fontSize: 9,
                    fontWeight: 700
                  }
                }, ws.unread)
              ),
              React.createElement("div", { style: { fontSize: 9.5, color: "#4a5568", marginTop: 2 } },
                `${ws.members?.length || 1} members · ${ws.chain?.length || 0} blocks`
              )
            )
          )
        ))
      )
    );
  };

  // ═══════════════════════════════════════════════════════════════════
  // 3. MEMBERS ROSTER COLUMN (Right side of Workspace chat)
  // ═══════════════════════════════════════════════════════════════════
  const WorkspaceRoster = ({ workspace, currentUserId, onKickMember, onInviteClick, th }) => {
    if (!workspace) return null;

    const members = workspace.members || [];
    const currentUserRole = members.find(m => m.id === currentUserId)?.role || 'member';
    const isOwnerOrAdmin = currentUserRole === 'owner' || currentUserRole === 'admin';

    // Helper to get name from PeerCache or fallback
    const getMemberName = (id) => {
      try {
        const cache = JSON.parse(localStorage.getItem('gl_peer_cache') || '{}');
        if (id === currentUserId) return "You";
        return cache[id]?.name || `Peer-${id.slice(0, 6)}`;
      } catch (e) {
        return id.slice(0, 8);
      }
    };

    return React.createElement("div", {
      style: {
        width: 240,
        background: th.bg2,
        borderLeft: "1px solid rgba(255,255,255,0.04)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0
      }
    },
      React.createElement("div", { style: { padding: "16px 14px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)" } },
        React.createElement("div", { style: { fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#8a8a9a" } }, "WORKSPACE ROSTER"),
        React.createElement("div", { style: { fontSize: 9, color: "#4a5568", marginTop: 2 } }, `${members.length} verified keys`)
      ),

      React.createElement("div", { style: { flex: 1, overflowY: "auto", padding: 10 } },
        members.map(member => {
          const name = getMemberName(member.id);
          const isSelf = member.id === currentUserId;
          return React.createElement("div", {
            key: member.id,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 6px",
              borderRadius: 8,
              marginBottom: 4,
              background: isSelf ? "rgba(255,255,255,0.02)" : "transparent"
            }
          },
            React.createElement("div", {
              style: {
                width: 28,
                height: 28,
                borderRadius: 8,
                background: isSelf ? `${th.accent}15` : "rgba(255,255,255,0.04)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                color: isSelf ? th.accent : "#c0c0c8"
              }
            }, name.charAt(0).toUpperCase()),

            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
              React.createElement("div", {
                style: {
                  fontSize: 11.5,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }
              }, name),
              React.createElement("div", { style: { display: "flex", gap: 4, alignItems: "center", marginTop: 2 } },
                React.createElement(Tag, {
                  color: member.role === 'owner' ? th.accent : member.role === 'admin' ? th.accent2 : '#64748b'
                }, member.role.toUpperCase()),
                React.createElement("span", { style: { fontSize: 8, color: "#3a3a4a", fontFamily: "monospace" } }, member.id.slice(0, 8))
              )
            ),

            isOwnerOrAdmin && !isSelf && member.role !== 'owner' && React.createElement("button", {
              onClick: () => onKickMember(member.id),
              title: "Remove member & rotate key",
              style: {
                background: "transparent",
                border: "none",
                color: "#ff4466",
                cursor: "pointer",
                padding: 4,
                opacity: 0.6,
                transition: "opacity 0.2s"
              },
              onMouseEnter: e => e.currentTarget.style.opacity = 1,
              onMouseLeave: e => e.currentTarget.style.opacity = 0.6
            },
              React.createElement(I, { t: "trash", s: 13 })
            )
          );
        })
      ),

      isOwnerOrAdmin && React.createElement("div", { style: { padding: 10, borderTop: "1px solid rgba(255,255,255,0.04)" } },
        React.createElement(Btn, {
          accent: true,
          style: { width: "100%", padding: "10px 0" },
          onClick: onInviteClick
        }, "+ Generate Invite")
      )
    );
  };

  // ═══════════════════════════════════════════════════════════════════
  // 4. CREATE WORKSPACE MODAL
  // ═══════════════════════════════════════════════════════════════════
  const WorkspaceCreateModal = ({ show, onClose, value, onChange, onCreate, th }) => {
    if (!show) return null;

    return React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: 16
      },
      onClick: onClose
    },
      React.createElement("div", {
        style: {
          background: "#0c0c12",
          border: `1px solid ${th.accent}18`,
          borderRadius: 18,
          padding: 24,
          maxWidth: 420,
          width: "100%",
          animation: "fadeInScale 0.2s ease"
        },
        onClick: e => e.stopPropagation()
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          React.createElement("span", { style: { fontSize: 15, fontWeight: 700, letterSpacing: 1 } }, "CREATE WORKSPACE"),
          React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", color: "#6a6a7a", cursor: "pointer" } },
            React.createElement(I, { t: "x", s: 18 })
          )
        ),
        React.createElement("p", { style: { fontSize: 11, color: "#5a5a6a", marginBottom: 16, lineHeight: 1.5 } },
          "Establish an independent collaborative environment with its own hash-chained history and workspace key rotation."
        ),
        React.createElement("input", {
          type: "text",
          placeholder: "Enter workspace name...",
          value: value,
          onChange: e => onChange(e.target.value),
          onKeyDown: e => e.key === "Enter" && onCreate(),
          style: {
            width: "100%",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10,
            padding: "12px 14px",
            color: "#fff",
            fontSize: 13,
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 20
          }
        }),
        React.createElement("div", { style: { display: "flex", gap: 10 } },
          React.createElement(Btn, { ghost: true, style: { flex: 1 }, onClick: onClose }, "Cancel"),
          React.createElement(Btn, { accent: true, style: { flex: 1 }, onClick: onCreate, disabled: !value.trim() }, "Create Workspace")
        )
      )
    );
  };

  // ═══════════════════════════════════════════════════════════════════
  // 5. JOIN WORKSPACE MODAL (Pasting invite)
  // ═══════════════════════════════════════════════════════════════════
  const WorkspaceJoinModal = ({ show, onClose, code, onCodeChange, words, onWordsChange, onJoin, th }) => {
    if (!show) return null;

    const isSecureInvite = () => {
      try {
        if (!code.trim().startsWith("GLWS-")) return false;
        const parsed = JSON.parse(window.CryptoEngine._base64Decode(code.trim().slice(5)));
        const keyData = parsed.encryptedWorkspaceKey;
        return keyData && typeof keyData === 'object' && keyData.ephemeralPubKeyHex;
      } catch (e) {
        return false;
      }
    };

    const secureNeeded = isSecureInvite();

    return React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: 16
      },
      onClick: onClose
    },
      React.createElement("div", {
        style: {
          background: "#0c0c12",
          border: `1px solid ${th.accent}18`,
          borderRadius: 18,
          padding: 24,
          maxWidth: 440,
          width: "100%",
          animation: "fadeInScale 0.2s ease"
        },
        onClick: e => e.stopPropagation()
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          React.createElement("span", { style: { fontSize: 15, fontWeight: 700, letterSpacing: 1 } }, "JOIN WORKSPACE"),
          React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", color: "#6a6a7a", cursor: "pointer" } },
            React.createElement(I, { t: "x", s: 18 })
          )
        ),
        React.createElement("p", { style: { fontSize: 11, color: "#5a5a6a", marginBottom: 14, lineHeight: 1.5 } },
          "Paste a workspace invite payload (GLWS-...) below to decrypt the vault and join the workspace."
        ),
        React.createElement("textarea", {
          rows: 3,
          placeholder: "GLWS-XXXXXXXX...",
          value: code,
          onChange: e => onCodeChange(e.target.value),
          style: {
            width: "100%",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10,
            padding: "12px 14px",
            color: "#fff",
            fontSize: 11,
            fontFamily: "monospace",
            boxSizing: "border-box",
            marginBottom: 14,
            resize: "none",
            outline: "none"
          }
        }),

        secureNeeded && React.createElement("div", { style: { animation: "fadeIn 0.25s ease" } },
          React.createElement("div", {
            style: {
              background: "rgba(255,170,0,0.06)",
              border: "1px solid rgba(255,170,0,0.15)",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 10.5,
              color: "#ffaa00",
              lineHeight: 1.5,
              marginBottom: 12
            }
          },
            "🔒 This invite is securely encrypted with ECIES for your public key only. Input your 12-word recovery seed below to temporarily derive the private key and decrypt it."
          ),
          React.createElement("input", {
            type: "password",
            placeholder: "12-word recovery seed phrase...",
            value: words,
            onChange: e => onWordsChange(e.target.value),
            style: {
              width: "100%",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: "12px 14px",
              color: "#fff",
              fontSize: 12,
              boxSizing: "border-box",
              marginBottom: 20,
              outline: "none"
            }
          })
        ),

        React.createElement("div", { style: { display: "flex", gap: 10 } },
          React.createElement(Btn, { ghost: true, style: { flex: 1 }, onClick: onClose }, "Cancel"),
          React.createElement(Btn, { accent: true, style: { flex: 1 }, onClick: onJoin, disabled: !code.trim() || (secureNeeded && !words.trim()) }, "Join Workspace")
        )
      )
    );
  };

  // ═══════════════════════════════════════════════════════════════════
  // 6. WORKSPACE SECURE INVITE GENERATION MODAL
  // ═══════════════════════════════════════════════════════════════════
  const WorkspaceInviteModal = ({ show, onClose, inviteType, onInviteTypeChange, recipientPub, onRecipientPubChange, onGenerate, inviteCode, th }) => {
    if (!show) return null;

    const [copied, setCopied] = useState(false);

    return React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: 16
      },
      onClick: onClose
    },
      React.createElement("div", {
        style: {
          background: "#0c0c12",
          border: `1px solid ${th.accent}18`,
          borderRadius: 18,
          padding: 24,
          maxWidth: 480,
          width: "100%",
          animation: "fadeInScale 0.2s ease"
        },
        onClick: e => e.stopPropagation()
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          React.createElement("span", { style: { fontSize: 15, fontWeight: 700, letterSpacing: 1 } }, "WORKSPACE INVITATION"),
          React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", color: "#6a6a7a", cursor: "pointer" } },
            React.createElement(I, { t: "x", s: 18 })
          )
        ),

        React.createElement("div", { style: { display: "flex", gap: 4, marginBottom: 16, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 3 } },
          React.createElement("button", {
            onClick: () => { onInviteTypeChange('public'); },
            style: {
              flex: 1,
              padding: "8px 0",
              borderRadius: 8,
              border: "none",
              background: inviteType === 'public' ? `${th.accent}15` : "transparent",
              color: inviteType === 'public' ? th.accent : "#5a5a6a",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase"
            }
          }, "Public (Plaintext)"),
          React.createElement("button", {
            onClick: () => { onInviteTypeChange('secure'); },
            style: {
              flex: 1,
              padding: "8px 0",
              borderRadius: 8,
              border: "none",
              background: inviteType === 'secure' ? `${th.accent}15` : "transparent",
              color: inviteType === 'secure' ? th.accent : "#5a5a6a",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase"
            }
          }, "Secure (ECIES Encrypted)")
        ),

        inviteType === 'public' ? (
          React.createElement("p", { style: { fontSize: 11, color: "#5a5a6a", marginBottom: 16, lineHeight: 1.5 } },
            "Generate a simple invite payload. Anyone who obtains this code will be able to join the workspace and decrypt its history."
          )
        ) : (
          React.createElement("div", null,
            React.createElement("p", { style: { fontSize: 11, color: "#5a5a6a", marginBottom: 10, lineHeight: 1.5 } },
              "Secure invites encrypt the workspace key using the recipient's public key (ECIES). Only the owner of that public key's private counterpart can decrypt and join."
            ),
            React.createElement("input", {
              type: "text",
              placeholder: "Paste recipient's ECDH Public Key (64-byte hex)...",
              value: recipientPub,
              onChange: e => onRecipientPubChange(e.target.value),
              style: {
                width: "100%",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
                padding: "12px 14px",
                color: "#fff",
                fontSize: 11,
                fontFamily: "monospace",
                boxSizing: "border-box",
                marginBottom: 16,
                outline: "none"
              }
            })
          )
        ),

        !inviteCode ? (
          React.createElement(Btn, {
            accent: true,
            style: { width: "100%" },
            onClick: onGenerate,
            disabled: inviteType === 'secure' && !recipientPub.trim()
          }, "Generate Invitation Code")
        ) : (
          React.createElement("div", { style: { animation: "fadeIn 0.25s ease" } },
            React.createElement("div", {
              style: {
                background: `${th.accent}05`,
                border: `1px dashed ${th.accent}20`,
                borderRadius: 10,
                padding: 12,
                fontFamily: "monospace",
                fontSize: 10,
                color: th.accent,
                wordBreak: "break-all",
                maxHeight: 120,
                overflowY: "auto",
                marginBottom: 16
              }
            }, inviteCode),
            React.createElement("div", { style: { display: "flex", gap: 10 } },
              React.createElement(Btn, {
                ghost: true,
                style: { flex: 1 },
                onClick: () => { onGenerate(); } // regenerate
              }, "Regenerate"),
              React.createElement(Btn, {
                accent: true,
                style: { flex: 1 },
                onClick: () => {
                  navigator.clipboard.writeText(inviteCode);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }, copied ? "Copied!" : "Copy Code")
            )
          )
        )
      )
    );
  };

  // Expose everything globally for use in index.html
  window.UpgradeModal = UpgradeModal;
  window.WorkspacePanel = WorkspacePanel;
  window.WorkspaceRoster = WorkspaceRoster;
  window.WorkspaceCreateModal = WorkspaceCreateModal;
  window.WorkspaceJoinModal = WorkspaceJoinModal;
  window.WorkspaceInviteModal = WorkspaceInviteModal;

})(typeof globalThis !== 'undefined' ? globalThis : this);
