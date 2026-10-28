#!/usr/bin/python3
"""A do-nothing org.kde.StatusNotifierWatcher for a private test bus.

Electron's Linux tray registers with this watcher when one owns the name;
without one it falls back to a GTK status icon, which segfaults under
--ozone-platform=headless. Real desktops have a watcher (the panel/bar).
Prints READY once the name is owned.
"""
import sys
from gi.repository import Gio, GLib

XML = """<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
</interface></node>"""
info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]

def call(conn, sender, path, iface, method, params, inv):
    inv.return_value(None)

def prop(conn, sender, path, iface, name):
    return {"RegisteredStatusNotifierItems": GLib.Variant("as", []),
            "IsStatusNotifierHostRegistered": GLib.Variant("b", True),
            "ProtocolVersion": GLib.Variant("i", 0)}[name]

def on_bus(conn, name):
    conn.register_object("/StatusNotifierWatcher", info, call, prop, None)

def on_name(conn, name):
    print("READY", flush=True)

conn = Gio.DBusConnection.new_for_address_sync(sys.argv[1],
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
on_bus(conn, None)
Gio.bus_own_name_on_connection(conn, "org.kde.StatusNotifierWatcher", Gio.BusNameOwnerFlags.NONE, on_name, None)
GLib.MainLoop().run()
