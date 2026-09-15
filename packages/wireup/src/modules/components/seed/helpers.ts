/**
 * Catalog authoring helpers.
 *
 * `pinTypes`, `powerPins` and `groundPins` are derived from the pin list unless
 * explicitly overridden, so a seed entry cannot disagree with itself.
 */

import type {
  ComponentDefinition,
  ComponentPin,
  ComponentPinType,
  PinDirection,
} from '@/types/component';

export interface ComponentDefinitionInput
  extends Partial<Omit<ComponentDefinition, 'id' | 'name' | 'category' | 'description' | 'pins'>> {
  id: string;
  name: string;
  category: ComponentDefinition['category'];
  description: string;
  pins: ComponentPin[];
}

export function pin(
  name: string,
  type: ComponentPinType,
  direction: PinDirection,
  options: Partial<ComponentPin> = {},
): ComponentPin {
  const { required = false, ...rest } = options;
  return { name, type, direction, required, ...rest };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function def(input: ComponentDefinitionInput): ComponentDefinition {
  const pins = input.pins;

  const pinTypes = input.pinTypes ?? unique(pins.map((entry) => entry.type));
  const powerPins =
    input.powerPins ?? pins.filter((entry) => entry.type === 'power' || entry.direction === 'power').map((entry) => entry.name);
  const groundPins =
    input.groundPins ?? pins.filter((entry) => entry.type === 'ground' || entry.direction === 'ground').map((entry) => entry.name);

  return {
    id: input.id,
    name: input.name,
    category: input.category,
    description: input.description,
    ...(input.voltage !== undefined ? { voltage: input.voltage } : {}),
    ...(input.minVoltage !== undefined ? { minVoltage: input.minVoltage } : {}),
    ...(input.maxVoltage !== undefined ? { maxVoltage: input.maxVoltage } : {}),
    ...(input.currentRequirements ? { currentRequirements: input.currentRequirements } : {}),
    pins,
    pinTypes,
    communicationProtocols: input.communicationProtocols ?? [],
    powerPins,
    groundPins,
    ...(input.compatibleMicrocontrollers ? { compatibleMicrocontrollers: input.compatibleMicrocontrollers } : {}),
    ...(input.incompatibleComponents ? { incompatibleComponents: input.incompatibleComponents } : {}),
    ...(input.motorRequirements ? { motorRequirements: input.motorRequirements } : {}),
    ...(input.powerSourceRequirements ? { powerSourceRequirements: input.powerSourceRequirements } : {}),
    ...(input.libraryRequirements ? { libraryRequirements: input.libraryRequirements } : {}),
    ...(input.exampleUsage ? { exampleUsage: input.exampleUsage } : {}),
    aliases: input.aliases ?? [],
    keywords: input.keywords ?? [],
    ...(input.simulator ? { simulator: input.simulator } : {}),
    metadata: input.metadata ?? {},
  };
}
