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

// ValhallaMC fix 2026-10-28 (Shadowfall 1.1.1 on Java 22+): Rhino throws TypeNotPresentException
// ("Type T not present") while it wraps some item classes. The throw happens outside the script's
// try/catch, so one bad item ended the whole handler and no gear got its tag. Each item now gets
// its own handler: KubeJS logs a failed handler and runs the next one. The tag rules are unchanged.
const TIER_IDS = []
$TagRegistries.ITEM.keySet().forEach(key => { TIER_IDS.push(String(key)) })
const TIER_STATE = { pending: null, done: 0, failed: [], added: {} }

function tierAdd(event, tag, id) {
  event.add(tag, id)
  TIER_STATE.added[tag] = (TIER_STATE.added[tag] || 0) + 1
}

function tierOne(event, id) {
  let item = $TagRegistries.ITEM.get(id)
  if (item instanceof $TagArmorItem) {
    let tag = TIER_ARMOR_TAGS[String(item.getEquipmentSlot().getName())]
    if (tag) tierAdd(event, tag, id)
  } else if (item instanceof $TagShieldItem) {
    tierAdd(event, 'c:tools/shields', id)
  } else if (item instanceof $TagCrossbowItem) {
    tierAdd(event, 'minecraft:enchantable/crossbow', id)
  } else if (item instanceof $TagProjectileWeaponItem) {
    tierAdd(event, 'minecraft:enchantable/bow', id)
  } else if (item instanceof $TagDiggerItem) {
    tierAdd(event, tierToolTag(item, id), id)
  } else if (item instanceof $TagTieredItem || item instanceof $TagTridentItem ||
      item instanceof $TagMaceItem || tierHasMeleeDamage(item)) {
    tierAdd(event, 'minecraft:enchantable/sword', id)
  }
}

ServerEvents.tags('item', event => {
  TIER_STATE.pending = null
  TIER_STATE.done = 0
  TIER_STATE.failed = []
  TIER_STATE.added = {}
})

TIER_IDS.forEach(id => {
  ServerEvents.tags('item', event => {
    if (TIER_STATE.pending != null) TIER_STATE.failed.push(TIER_STATE.pending)
    TIER_STATE.pending = id
    try {
      tierOne(event, id)
    } catch (e) {
      console.error('[arcadia] tiered tags error for ' + id + ': ' + e)
    }
    TIER_STATE.pending = null
    TIER_STATE.done++
  })
})

ServerEvents.tags('item', event => {
  if (TIER_STATE.pending != null) TIER_STATE.failed.push(TIER_STATE.pending)
  TIER_STATE.pending = null
  console.info('[arcadia] tiered tags: ' + TIER_STATE.done + ' of ' + TIER_IDS.length + ' items checked, added ' +
    JSON.stringify(TIER_STATE.added) + ', failed ' + TIER_STATE.failed.length + ': ' + TIER_STATE.failed.join(', '))
})
