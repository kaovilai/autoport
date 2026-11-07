// js/targets/macrodroid/pluginRegistry.js — Tasker/Locale plugin identity
// data needed to emit MacroDroid LocalePluginAction nodes.
//
// m_plugin (the Plugin model MacroDroid serializes) identifies the plugin by
// package + edit-activity + fire-receiver + registry name ("pkg:activity").
// The Tasker XML export carries package (arg1) and the config activity
// (arg2); the FIRE receiver only exists in the plugin app's own manifest.
//
// AutoInput entry measured from the real APK (Play, original signature):
//   versionName 3.0.12, versionCode 104
//   <receiver android:name="com.joaomgcd.autoinput.broadcastreceiver.BroadcastReceiverFire">
//     <intent-filter> com.twofortyfouram.locale.intent.action.FIRE_SETTING </intent-filter>
//   </receiver>
//   query (condition) receiver: ...BroadcastReceiverQuery — QUERY_CONDITION
//   config activities seen in Tasker exports: activity.ActivityConfigPerformAction
//   (v1) and activity.ActivityConfigActionv2 (v2 DSL).
// One FIRE receiver serves every setting-type plugin the app exports.

export const PLUGIN_REGISTRY = Object.freeze({
  'com.joaomgcd.autoinput': Object.freeze({
    package: 'com.joaomgcd.autoinput',
    settingReceiver: 'com.joaomgcd.autoinput.broadcastreceiver.BroadcastReceiverFire',
    conditionReceiver: 'com.joaomgcd.autoinput.broadcastreceiver.BroadcastReceiverQuery',
    versionCode: 104,
    source: 'AutoInput 3.0.12 APK (com.joaomgcd.autoinput-104.apk) AndroidManifest.xml',
  }),
});

/** Look up a plugin's identity. Unknown packages get a best-effort entry
 *  derived from the Tasker XML itself (receiver unknown -> null; MacroDroid
 *  will show the action but cannot fire it until the plugin is picked). */
export function lookupPlugin(packageName) {
  const hit = PLUGIN_REGISTRY[packageName];
  if (hit) return { ...hit, known: true };
  return {
    package: packageName,
    settingReceiver: null,
    conditionReceiver: null,
    versionCode: 0,
    source: 'unknown plugin — receiver not in registry',
    known: false,
  };
}
