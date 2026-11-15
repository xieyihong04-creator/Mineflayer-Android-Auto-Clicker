plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// M3 step 3: the app owns the bot instead of expecting Termux to run
// `npm start`. Node itself runs in the private `:node` process (see
// NodeService) while this module keeps the WebView + the foreground service in
// the main process; they talk over the same 127.0.0.1 WebSocket as M1/M2.
//
// libnode.so comes from nodejs-mobile (no Maven artifact); the download is
// shared with :probe so both APKs pin the same Node version and ABI.
apply(from = rootProject.file("libnode.gradle.kts"))

// Only used by the bundle verification step (it proves the pruned
// minecraft-data can build a serializer for every version).
val mcVersion = (findProperty("appMinecraftVersion") as String?) ?: "1.20.1"

val nodeBundleDir = layout.buildDirectory.dir("node")
val nodeAssetDir = layout.buildDirectory.dir("generated/nodeAssets")

android {
    namespace = "dev.mcbot.console"
    compileSdk = 35
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = "dev.mcbot.console"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.1.0-m3"
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

    // build/libnode/bin holds libnode.so; build/generated/nodeAssets holds the
    // single node.zip (src + web + node_modules + entry.js).
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
    // Only for ContextCompat (receiver flags, startForegroundService).
    implementation("androidx.core:core-ktx:1.13.1")
}

/**
 * Installs the dependency tree, prunes minecraft-data (dataPaths-driven, with a
 * build-time serializer check for every version), then adds src/, web/ and
 * entry.js. Fails here instead of on the phone.
 */
val bundleNode = tasks.register<Exec>("bundleNode") {
    val repoRoot = rootProject.projectDir.parentFile
    inputs.file(repoRoot.resolve("package.json"))
    inputs.file(repoRoot.resolve("package-lock.json"))
    inputs.file(repoRoot.resolve("android/app/src/main/js/entry.js"))
    inputs.dir(repoRoot.resolve("src"))
    inputs.dir(repoRoot.resolve("web"))
    inputs.file(rootProject.projectDir.resolve("probe/tools/prepare-bundle.js"))
    inputs.file(rootProject.projectDir.resolve("libnode.gradle.kts"))
    outputs.dir(nodeBundleDir)
    commandLine(
        "bash",
        rootProject.projectDir.resolve("probe/tools/bundle-node.sh").absolutePath,
        repoRoot.absolutePath,
        nodeBundleDir.get().asFile.absolutePath,
        mcVersion,
        "app"
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
    // Registered by libnode.gradle.kts.
    dependsOn("fetchLibNode", nodeAsset)
}
