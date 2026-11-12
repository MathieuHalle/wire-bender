<script setup lang="ts">
// Right after deleting your account (Settings › Account): signed out, and how to come back.
definePageMeta({ layout: 'auth' })
useHead({ title: 'Account deleted · WireBender' })
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 class="text-lg font-semibold">
      Your account is deleted.
    </h1>
    <p class="text-sm">
      You are signed out. Sign back in within 30 days to restore your account and keep your
      boards. After that, they are removed for good.
    </p>
    <div class="flex gap-2">
      <UButton
        to="/login"
        label="Sign in"
      />
      <UButton
        to="/"
        label="Home"
        color="neutral"
        variant="outline"
      />
    </div>
  </div>
</template>
