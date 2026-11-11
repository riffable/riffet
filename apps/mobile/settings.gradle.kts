// Riffet mobile client (Compose Multiplatform).
//
// This Gradle build is deliberately independent of the repository's pnpm/Node build:
// the root `pnpm-workspace.yaml` has no `packages:` field, and apps/mobile is not part of it.
// `apps/mobile` can be opened and built on its own.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "riffet-mobile"

include(":contracts")
include(":core")
include(":terminal")
include(":client")
include(":shared")
include(":androidApp")
