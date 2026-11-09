package com.passdroid.next

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // Block screenshots/screen recording and blank the content shown in the
    // recents/task switcher, so passwords can't leak via captures or thumbnails.
    // Debuggable builds (the side-by-side com.passdroid.next.debug used only for
    // on-device testing with test vaults) skip it so the UI can be inspected;
    // release builds are never debuggable, so they always get FLAG_SECURE.
    val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debuggable) {
      window.setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE,
      )
    }
    super.onCreate(savedInstanceState)
  }
}
