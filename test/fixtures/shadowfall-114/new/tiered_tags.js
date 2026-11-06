// Tiered More tiers only items in the tags its tier files name: the four armor tags, the
// tool tags, minecraft:swords or enchantable/sword, enchantable/bow or enchantable/crossbow,
// and c:tools/shields. Many mods leave their gear out of these, so it could not be tiered.
// Add every piece of gear to the tag for what it is. Body armor (horse, wolf and dragon
// armor) goes on animals, where tiers do nothing, so it stays out.

const $TagArmorItem = Java.loadClass('net.minecraft.world.item.ArmorItem')
const $TagShieldItem = Java.loadClass('net.minecraft.world.item.ShieldItem')
const $TagCrossbowItem = Java.loadClass('net.minecraft.world.item.CrossbowItem')
const $TagProjectileWeaponItem = Java.loadClass('net.minecraft.world.item.ProjectileWeaponItem')
const $TagTridentItem = Java.loadClass('net.minecraft.world.item.TridentItem')
const $TagMaceItem = Java.loadClass('net.minecraft.world.item.MaceItem')
const $TagTieredItem = Java.loadClass('net.minecraft.world.item.TieredItem')
const $TagDiggerItem = Java.loadClass('net.minecraft.world.item.DiggerItem')
const $TagPickaxeItem = Java.loadClass('net.minecraft.world.item.PickaxeItem')
const $TagAxeItem = Java.loadClass('net.minecraft.world.item.AxeItem')
const $TagShovelItem = Java.loadClass('net.minecraft.world.item.ShovelItem')
const $TagHoeItem = Java.loadClass('net.minecraft.world.item.HoeItem')
const $TagRegistries = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries')
const $TagDataComponents = Java.loadClass('net.minecraft.core.component.DataComponents')
const $TagAttributes = Java.loadClass('net.minecraft.world.entity.ai.attributes.Attributes')

const TIER_ARMOR_TAGS = {
  head: 'minecraft:head_armor',
  chest: 'minecraft:chest_armor',
  legs: 'minecraft:leg_armor',
  feet: 'minecraft:foot_armor'
}

// Digger items that are not one of the four vanilla classes (hammers, excavators, paxels)
// are named after what they mine like.
function tierToolTag(item, id) {
  if (item instanceof $TagPickaxeItem) return 'minecraft:pickaxes'
  if (item instanceof $TagAxeItem) return 'minecraft:axes'
  if (item instanceof $TagShovelItem) return 'minecraft:shovels'
  if (item instanceof $TagHoeItem) return 'minecraft:hoes'
  if (/pickaxe|hammer|paxel/.test(id)) return 'minecraft:pickaxes'
  if (/shovel|excavator|spade/.test(id)) return 'minecraft:shovels'
  if (/hoe|scythe|sickle/.test(id)) return 'minecraft:hoes'
  if (/axe/.test(id)) return 'minecraft:axes'
  return 'minecraft:pickaxes'
}

function tierHasMeleeDamage(item) {
  let mods = item.components().get($TagDataComponents.ATTRIBUTE_MODIFIERS)
  if (mods == null) return false
  let list = mods.modifiers()
  for (let i = 0; i < list.size(); i++) {
    let e = list.get(i)
    if (e.attribute().value() == $TagAttributes.ATTACK_DAMAGE.value() && e.modifier().amount() > 0) return true
  }
  return false
}

function tierOne(event, id) {
  let item = $TagRegistries.ITEM.get(id)
  if (item instanceof $TagArmorItem) {
    let tag = TIER_ARMOR_TAGS[String(item.getEquipmentSlot().getName())]
    if (tag) event.add(tag, id)
  } else if (item instanceof $TagShieldItem) {
    event.add('c:tools/shields', id)
  } else if (item instanceof $TagCrossbowItem) {
    event.add('minecraft:enchantable/crossbow', id)
  } else if (item instanceof $TagProjectileWeaponItem) {
    event.add('minecraft:enchantable/bow', id)
  } else if (item instanceof $TagDiggerItem) {
    event.add(tierToolTag(item, id), id)
  } else if (item instanceof $TagTieredItem || item instanceof $TagTridentItem ||
      item instanceof $TagMaceItem || tierHasMeleeDamage(item)) {
    event.add('minecraft:enchantable/sword', id)
  }
}

// On Java 22 and later Rhino cannot wrap some items (TypeNotPresentException, seen on
// cataclysm:the_annihilator and the_immolator). A script catch does not see that error, and it
// ends the handler. So each item has its own handler: KubeJS logs a failed one and runs the next.
const TIER_IDS = []
$TagRegistries.ITEM.keySet().forEach(key => { TIER_IDS.push(String(key)) })
const TIER_RUN = { current: null, checked: 0, skipped: [] }

ServerEvents.tags('item', event => {
  TIER_RUN.current = null
  TIER_RUN.checked = 0
  TIER_RUN.skipped = []
})

// An item still current when the next handler starts is one whose handler failed.
TIER_IDS.forEach(id => {
  ServerEvents.tags('item', event => {
    if (TIER_RUN.current != null) TIER_RUN.skipped.push(TIER_RUN.current)
    TIER_RUN.current = id
    tierOne(event, id)
    TIER_RUN.current = null
    TIER_RUN.checked++
  })
})

ServerEvents.tags('item', event => {
  if (TIER_RUN.current != null) TIER_RUN.skipped.push(TIER_RUN.current)
  TIER_RUN.current = null
  console.info('Tiered tags: ' + TIER_RUN.checked + ' of ' + TIER_IDS.length + ' items checked' +
    (TIER_RUN.skipped.length > 0 ? '. Skipped: ' + TIER_RUN.skipped.join(', ') : ''))
})
