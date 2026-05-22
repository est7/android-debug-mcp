import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A miniature Poppo-shaped source tree, materialized into a scratch directory
 * for `recipe.test.ts`. It is built at runtime (not committed as files)
 * because the `build/` subtree below would otherwise collide with the repo
 * `.gitignore`'s `build/` rule — and the `build/` exclusion is precisely what
 * one of the recipe tests must verify.
 *
 * Shape (ViewBinding-only, mirroring v2-A open decision #2):
 *
 *   app/src/main/res/layout/activity_login.xml      @+id/login_button,
 *                                                   @+id/face_mask_top,
 *                                                   @+id/login_button_extra
 *   app/src/main/res/layout/fragment_profile.xml    @+id/profile_avatar
 *   app/src/main/java/.../LoginActivity.kt          BaseBindingActivity<ActivityLoginBinding>,
 *                                                   binding.loginButton, binding.faceMaskTop
 *   app/src/main/java/.../ProfileFragment.kt        BaseBindingFragment<FragmentProfileBinding>,
 *                                                   binding.profileAvatar
 *   app/src/generated/.../StubGenerated.kt          binding.loginButton — under a
 *                                                   `generated` segment ⇒ generated_noise
 *   app/build/.../ActivityLoginBinding.java         binding.loginButton — under build/ ⇒ excluded
 */
export function materializeSourceFixture(root: string): void {
  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const ACTIVITY_LOGIN_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">
    <Button
        android:id="@+id/login_button"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content" />
    <ImageView
        android:id="@+id/face_mask_top"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content" />
    <View
        android:id="@+id/login_button_extra"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content" />
</LinearLayout>
`;

const FRAGMENT_PROFILE_XML = `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">
    <ImageView
        android:id="@+id/profile_avatar"
        android:layout_width="48dp"
        android:layout_height="48dp" />
</FrameLayout>
`;

const LOGIN_ACTIVITY_KT = `package com.example.poppo

import android.os.Bundle
import android.view.View

class LoginActivity : BaseBindingActivity<ActivityLoginBinding>() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding.loginButton.setOnClickListener { doLogin() }
        binding.faceMaskTop.visibility = View.GONE
    }

    private fun doLogin() = Unit
}
`;

const PROFILE_FRAGMENT_KT = `package com.example.poppo

class ProfileFragment : BaseBindingFragment<FragmentProfileBinding>() {
    fun bind() {
        binding.profileAvatar.setImageResource(0)
    }
}
`;

const STUB_GENERATED_KT = `package com.example.poppo

// This file sits under a \`generated\` path segment (not build/), so a code
// reference here must be classified generated_noise, never a trusted code_ref.
object StubGenerated {
    fun touch(binding: ActivityLoginBinding) {
        binding.loginButton.hashCode()
    }
}
`;

const GENERATED_BINDING_JAVA = `package com.example.poppo.databinding;

// Generated ViewBinding class under build/. The comment below WOULD match the
// code_ref search; the recipe's build/ exclusion must keep it out entirely.
//   binding.loginButton
public final class ActivityLoginBinding {
}
`;

const FIXTURE_FILES: Record<string, string> = {
  "app/src/main/res/layout/activity_login.xml": ACTIVITY_LOGIN_XML,
  "app/src/main/res/layout/fragment_profile.xml": FRAGMENT_PROFILE_XML,
  "app/src/main/java/com/example/poppo/LoginActivity.kt": LOGIN_ACTIVITY_KT,
  "app/src/main/java/com/example/poppo/ProfileFragment.kt": PROFILE_FRAGMENT_KT,
  "app/src/generated/com/example/poppo/StubGenerated.kt": STUB_GENERATED_KT,
  "app/build/generated/data_binding/com/example/poppo/databinding/ActivityLoginBinding.java":
    GENERATED_BINDING_JAVA,
};
