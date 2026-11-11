import { i18n } from '@lingui/core';

// Web modules word their user-facing errors through Lingui. Tests that import such a module
// directly never run the UI's locale bootstrap, so activate the source locale here. With no
// catalog loaded, `i18n._` falls back to the message text — what these tests assert.
i18n.load('zh-Hans', {});
i18n.activate('zh-Hans');
