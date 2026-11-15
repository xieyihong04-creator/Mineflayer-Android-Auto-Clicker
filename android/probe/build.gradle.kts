plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// M3 probe: everything here exists to answer one question on a real device --
// "can mineflayer connect when it runs inside nodejs-mobile?" Nothing in :app
// depends on this module, and this module must not grow into the product.
//
// From M3 step 3 the product app also runs libnode; the download lives in
// ../libnode.gradle.kts so both modules pin the same Node version and ABI.
apply(from = rootProject.file("libnode.gradle.kts"))

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
        versionCode = 10
        versionName = "0.1.0-m3-probe10"
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
 * Installs the production dependency tree (mineflayer), prunes minecraft-data
 * to a single version, and drops probe.js next to node_modules.
 */
val bundleNode = tasks.register<Exec>("bundleNode") {
    val repoRoot = rootProject.projectDir.parentFile
    inputs.file(repoRoot.resolve("package.json"))
    inputs.file(repoRoot.resolve("package-lock.json"))
    inputs.file(repoRoot.resolve("android/probe/src/main/js/probe.js"))
    inputs.file(rootProject.projectDir.resolve("libnode.gradle.kts"))
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
    // Registered by libnode.gradle.kts.
    dependsOn("fetchLibNode", nodeAsset)
}
