import java.net.URI
import java.util.zip.ZipInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// M3 probe: everything here exists to answer one question on a real device --
// "can mineflayer connect when it runs inside nodejs-mobile?" Nothing in :app
// depends on this module, and this module must not grow into the product.
val libNodeVersion = "v18.20.4"
val libNodeUrl = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/" +
    "$libNodeVersion/nodejs-mobile-$libNodeVersion-android.zip"
val mcVersion = (findProperty("probeMinecraftVersion") as String?) ?: "1.20.1"

val libNodeDir = layout.buildDirectory.dir("libnode")
val nodeBundleDir = layout.buildDirectory.dir("node")
val nodeAssetDir = layout.buildDirectory.dir("generated/nodeAssets")

android {
    namespace = "dev.mcbot.probe"
    compileSdk = 35
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = "dev.mcbot.console.probe"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "0.1.0-m3-probe4"
        // arm64 only: libnode.so is ~62 MB per ABI and the target device is
        // arm64. Add "x86_64" here if you also want to run it in an emulator.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets["main"].jniLibs.srcDir(file("build/libnode/bin"))
    sourceSets["main"].assets.srcDir(file("build/generated/nodeAssets"))

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs.keepDebugSymbols += "**/libnode.so"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}

/**
 * libnode.so is not on Maven; nodejs-mobile publishes it as a zip per release.
 * Downloaded once into build/libnode, then consumed as jniLibs.
 */
val fetchLibNode = tasks.register("fetchLibNode") {
    outputs.dir(libNodeDir)
    doLast {
        val out = libNodeDir.get().asFile
        val marker = out.resolve("bin/arm64-v8a/libnode.so")
        if (marker.exists()) {
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
                // Only the two ABIs we ship plus the headers for the JNI shim.
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
        check(out.resolve("bin/arm64-v8a/libnode.so").exists()) { "libnode.so arm64-v8a missing in release zip" }
        check(out.resolve("include/node/node.h").exists()) { "node.h missing in release zip" }
    }
}

/**
 * Installs the production dependency tree (mineflayer), prunes minecraft-data
 * to a single version, and drops probe.js next to node_modules.
 */
val bundleNode = tasks.register<Exec>("bundleNode") {
    val repoRoot = rootProject.projectDir.parentFile
    inputs.file(repoRoot.resolve("package.json"))
    inputs.file(repoRoot.resolve("package-lock.json"))
    inputs.file(repoRoot.resolve("android/probe/src/main/js/probe.js"))
    outputs.dir(nodeBundleDir)
    commandLine(
        "bash",
        rootProject.projectDir.resolve("probe/tools/bundle-node.sh").absolutePath,
        repoRoot.absolutePath,
        nodeBundleDir.get().asFile.absolutePath,
        mcVersion
    )
}

val nodeAsset = tasks.register<Zip>("nodeAsset") {
    dependsOn(bundleNode)
    from(nodeBundleDir)
    destinationDirectory.set(nodeAssetDir)
    archiveFileName.set("node.zip")
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.named("preBuild") {
    dependsOn(fetchLibNode, nodeAsset)
}
