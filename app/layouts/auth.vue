<template>
  <UMain class="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
    <NuxtLink
      to="/"
      class="flex items-center gap-2"
    >
      <img
        src="/icon.svg"
        alt=""
        class="size-8"
      >
      <span class="text-xl font-semibold">WireBender</span>
    </NuxtLink>
    <UCard class="w-full max-w-md">
      <slot />
    </UCard>
  </UMain>
</template>
