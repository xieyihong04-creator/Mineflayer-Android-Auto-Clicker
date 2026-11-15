package dev.mcbot.console

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * assets/node.zip -> filesDir/node.
 *
 * The stamp is the digest of the shipped bundle, not a plain "done" marker: an
 * in-place APK update used to keep the *old* extracted JS and the app happily
 * served the previous version. Any change to node.zip must force a clean
 * re-extract.
 *
 * Nothing persistent lives here - config.json, logs/ and auth/ (the Microsoft
 * token cache) sit one level up in filesDir, see entry.js.
 */
object NodeBundle {
    const val DIR = "node"
    const val ENTRY = "entry.js"

    fun dir(context: Context): File = File(context.filesDir, DIR)

    fun ensure(context: Context): File {
        val dest = dir(context)
        val stamp = File(dest, ".bundle-ok")
        val want = digest(context)
        if (stamp.exists() && stamp.readText().trim() == want) return dest

        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()
        context.assets.open("node.zip").use { raw ->
            ZipInputStream(raw.buffered()).use { zin ->
                while (true) {
                    val entry = zin.nextEntry ?: break
                    val target = File(dest, entry.name)
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        FileOutputStream(target).use { zin.copyTo(it) }
                    }
                    zin.closeEntry()
                }
            }
        }
        stamp.writeText(want)
        return dest
    }

    /** First 16 hex chars of the bundled zip's SHA-256 (~15 MB, once per launch). */
    private fun digest(context: Context): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        context.assets.open("node.zip").use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }.take(16)
    }
}
