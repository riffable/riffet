// The Android host: a plain Android application module. AGP 9 compiles its Kotlin itself (built-in
// Kotlin), and does not allow `org.jetbrains.kotlin.multiplatform` next to `com.android.application`,
// so the multiplatform code lives in :shared and this module only hosts it. The iOS host will be its
// own project under iosApp/ (P4), not a target of this module.
plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
}

/** A Gradle property (`-Pname=…` or gradle.properties) or, failing that, an environment variable. */
fun buildSetting(property: String, environment: String): String? =
    providers.gradleProperty(property).orElse(providers.environmentVariable(environment)).orNull
        ?.takeIf { it.isNotBlank() }

// The shared debug key is intentionally versioned so builds on every machine can update each other.
val debugStoreFile = buildSetting("riffet.debugSigning.storeFile", "RIFFET_DEBUG_SIGNING_STORE_FILE")
    ?: "signing/debug.keystore"

// Release signing is configured only when all four values are supplied from outside the checkout;
// otherwise the release build is produced unsigned. Release keys and passwords stay outside Git.
val releaseStoreFile = buildSetting("riffet.signing.storeFile", "RIFFET_SIGNING_STORE_FILE")
val releaseStorePassword = buildSetting("riffet.signing.storePassword", "RIFFET_SIGNING_STORE_PASSWORD")
val releaseKeyAlias = buildSetting("riffet.signing.keyAlias", "RIFFET_SIGNING_KEY_ALIAS")
val releaseKeyPassword = buildSetting("riffet.signing.keyPassword", "RIFFET_SIGNING_KEY_PASSWORD")
val releaseSigned = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { it != null }

// All clients share the root package.json version; see scripts/version.ts.
val riffetPackage = groovy.json.JsonSlurper().parse(rootDir.resolve("../../package.json")) as Map<*, *>

// AppCompat appends the device's fallback languages. Give Chinese an explicit qualifier so an
// English system fallback cannot beat our unqualified Chinese copy. Keep a single source catalog.
abstract class ChineseResources : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val catalogs: ConfigurableFileCollection
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val directory = outputDirectory.get().dir("values-zh").asFile.apply { mkdirs() }
        catalogs.files.forEachIndexed { index, source -> source.copyTo(directory.resolve("strings_$index.xml"), overwrite = true) }
    }
}
val chineseResources = tasks.register<ChineseResources>("generateChineseResources") {
    catalogs.from(layout.projectDirectory.file("src/main/res/values/strings.xml"),
        project(":shared").layout.projectDirectory.file("src/androidMain/res/values/strings.xml"))
    outputDirectory.set(layout.buildDirectory.dir("generated/res/appLanguages"))
}

android {
    namespace = "riffet.android"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        applicationId = "io.github.riffable.android"
        minSdk = libs.versions.androidMinSdk.get().toInt()
        targetSdk = libs.versions.androidTargetSdk.get().toInt()
        versionCode = (riffetPackage["buildNumber"] as Number).toInt()
        versionName = riffetPackage["version"] as String
    }

    signingConfigs {
        getByName("debug") {
            storeFile = file(debugStoreFile)
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (releaseSigned) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseSigned) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        // RiffetActivity reads BuildConfig.DEBUG to keep the adb server override out of release builds.
        buildConfig = true
    }
}

androidComponents.onVariants { variant ->
    variant.sources.res?.addGeneratedSourceDirectory(chineseResources, ChineseResources::outputDirectory)
}

dependencies {
    implementation(project(":shared"))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.window)
    implementation(libs.compose.runtime)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
}
