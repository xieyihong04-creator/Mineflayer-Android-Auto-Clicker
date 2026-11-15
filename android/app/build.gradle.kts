plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.mcbot.console"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.mcbot.console"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.0-m2"
    }

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
}

dependencies {
    // Only for ContextCompat (receiver flags, startForegroundService).
    implementation("androidx.core:core-ktx:1.13.1")
}
