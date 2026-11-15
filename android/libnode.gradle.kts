// Shared by :app and :probe.
//
// libnode.so is not on Maven; nodejs-mobile publishes it as a zip per release.
// Downloading it in one place keeps the Node version (and therefore the ABI and
// the 4 KB segment alignment) identical in both APKs.
import java.net.URI
import java.util.zip.ZipInputStream

val libNodeVersion = "v18.20.4"
val libNodeUrl = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/" +
    "$libNodeVersion/nodejs-mobile-$libNodeVersion-android.zip"
val libNodeDirProvider = layout.buildDirectory.dir("libnode")

tasks.register("fetchLibNode") {
    outputs.dir(libNodeDirProvider)
    doLast {
        val out = libNodeDirProvider.get().asFile
        val marker = out.resolve("bin/arm64-v8a/libnode.so")
        if (marker.exists() && out.resolve("include/node/node.h").exists()) {
            logger.lifecycle("libnode already present: ${marker.length()} bytes")
            return@doLast
        }
        out.mkdirs()
        val zip = out.resolve("nodejs-mobile.zip")
        logger.lifecycle("downloading $libNodeUrl")
        URI(libNodeUrl).toURL().openStream().use { input ->
            zip.outputStream().use { input.copyTo(it) }
        }
        ZipInputStream(zip.inputStream().buffered()).use { zin ->
            while (true) {
                val entry = zin.nextEntry ?: break
                // Only the shipped ABI plus the headers for the JNI shim.
                val wanted = entry.name.startsWith("include/") ||
                    entry.name == "bin/arm64-v8a/libnode.so" ||
                    entry.name == "bin/x86_64/libnode.so"
                if (wanted && !entry.isDirectory) {
                    val target = out.resolve(entry.name)
                    target.parentFile.mkdirs()
                    target.outputStream().use { zin.copyTo(it) }
                }
                zin.closeEntry()
            }
        }
        zip.delete()
        check(marker.exists()) { "libnode.so arm64-v8a missing in release zip" }
        check(out.resolve("include/node/node.h").exists()) { "node.h missing in release zip" }
    }
}
