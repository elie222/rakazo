/**
 * Gives each file in a group a reference of its own.
 *
 * The xcode library reuses an existing reference with the same path, so a second extension's
 * `Info.plist` would also join the first extension's group. Xcode refuses to open a project
 * where one reference "is a member of more than one group".
 */
function giveGroupOwnFiles(project, groupUuid) {
  const groups = project.hash.project.objects.PBXGroup;
  const references = project.pbxFileReferenceSection();
  for (const child of groups[groupUuid].children) {
    const shared = Object.entries(groups).some(
      ([key, other]) =>
        key !== groupUuid &&
        typeof other === "object" &&
        other.children?.some((entry) => entry.value === child.value),
    );
    if (!shared) continue;
    const uuid = project.generateUuid();
    references[uuid] = { ...references[child.value] };
    references[`${uuid}_comment`] = references[`${child.value}_comment`];
    child.value = uuid;
  }
}

/** Adds a group like `project.addPbxGroup`, but gives each of its files a reference of its own. */
function addPbxGroupWithOwnFiles(project, files, name, groupPath) {
  const group = project.addPbxGroup(files, name, groupPath);
  giveGroupOwnFiles(project, group.uuid);
  return group;
}

module.exports = { addPbxGroupWithOwnFiles, giveGroupOwnFiles };
