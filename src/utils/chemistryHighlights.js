import { getChemistry } from '../data/chemistry'

export const CHEMISTRY_NOTE_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAXCAYAAAALHW+jAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAOoSURBVEhLnZVdaFtlHMafJCfdlq/mo0nTuH5Imzq6sTFnGbilWRFEcDgQhnqlgoo3eiFeiHgxFG+HV4IXwkARxvTCoaAgq4I4OubNtpS5tbJl7ZouzUdzzklyTs858fkn62jVLuIDvyQn583vvO///YgL22ecnCSH21fAJXKO/NG++h95jSwdCAZbBwk/3yWnyWNk23juv/9bjpPnTk4exiuZKazU9eCtUmmE3+0kt0iJ/CMPE2bJ9DNHs3j9xPMYDgWRL97bkD5CiuQO2ZKuwuz4OJ46cBBDqd2bpTLsAaIT6WmdtNNd2J9AZiAJeL0YiYTbUrNWU4qVyrDuOBNsYxApQVvaXRgKIdvjZT+KUDQVQ7t2YU80iojLpVRqtVTBNB9lO+lpW9pdGPRjumXDtVKAq1qCW1URC4Yw0deHqGUhr6rxzdL/0EM/bLOJ83cLMEwTAdsiNvxuD4cfQtjj2ZCyLpjvLgyHsMSenF4qIKc3UGg0EDUMJLgyfRz+sM+HZrOJa2trUda02F0Yj8PtUfB9cRW3DaMxp9fX52uqF60WBiiM9fTA4zi4zolaaDY1d+e3D4kv0KGTC6uWdea8qt75OJ/HheVFoKEi7nEhsVPWO8KbhTHyJHmVvEuOEKyzTlZvr3yU/E7OkCtzuo5ctcJFo6GgrWGZpWAaG0I5CN4kp8gH5H2SIbD5ZKvzdMkgOUpGkoqCpFdByXIwU63hiqbJ/bLCF5G9QV7iQZA6lk4jnExibWUFv9y4IY02R+o6Rdnoi/EY9geDOHevgrPFMoqWJdvwohxf75G3sul06u0jGWT27UcwkYC6mMfs5UsIuFyYWVzEh7OzbAbwoXiBJRjrUZDj8vm6VEFO00T2JflchvwEn5g6MTaGpycnEenvh0JJxO/H8aEhHHM58JRXxdVO1O1GnaKviiV8urS8RUYWZMixfYEAHufUK9fnANamnWqZFVmFU63Cqbe3qVS9dU3XfVd1vcHZFpEctj+Tb8kCgQz5u+ne3mdPpUcxxbpIHHO9I7FM5NQ6PuIu+aZWu8lbPxHZYk1ylfxJRMTp7kQW9l7Ntg8566Z30LHRZxqwVR223mzLPiuV8QNnsO448hfwCZHeXCSyhOQUF/mDiFBh4z23DXNwXqtjuW4gb5iYYQ+/4HB/5Hq7P4NnifRQerNF8vdEyMvkV6LHFaU1sWNHS955LcX7jbxDRknXbPzrifQQ2Ut2EymmnMTcW+BM4TJ5UKftA/wFWNCLUsUz06cAAAAASUVORK5CYII='

export function charactersHaveGoodChemistry(leftName, rightName) {
  if (!leftName || !rightName || leftName === rightName) return false
  const leftChem = getChemistry(leftName)
  const rightChem = getChemistry(rightName)
  return leftChem.good.includes(rightName) || rightChem.good.includes(leftName)
}

export function buildChemistryHighlightSet(activeCharacterId, characters = []) {
  if (!activeCharacterId || !Array.isArray(characters) || characters.length === 0) return new Set()
  const activeCharacter = characters.find((character) => String(character.id) === String(activeCharacterId))
  if (!activeCharacter) return new Set()

  const activeName = activeCharacter.chemistryName || activeCharacter.name
  return new Set(
    characters
      .filter((character) => String(character.id) !== String(activeCharacterId))
      .filter((character) => charactersHaveGoodChemistry(activeName, character.chemistryName || character.name))
      .map((character) => character.id),
  )
}
