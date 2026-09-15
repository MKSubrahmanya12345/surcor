/**
 * Runtime schema for catalog entries.
 *
 * Used when seeding and when accepting externally authored components, so a
 * malformed entry can never poison the planner.
 */

import { z } from 'zod';

export const ComponentPinSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    'digital',
    'analog',
    'pwm',
    'uart',
    'i2c',
    'spi',
    'one_wire',
    'power',
    'ground',
    'motor',
    'enable',
    'control',
    'signal',
    'other',
  ]),
  direction: z.enum(['input', 'output', 'bidirectional', 'power', 'ground']),
  required: z.boolean(),
  signal: z.string().optional(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  voltage: z.number().optional(),
  minVoltage: z.number().optional(),
  maxVoltage: z.number().optional(),
  requiresCapability: z.array(z.string()).optional(),
});

export const LibraryRequirementSchema = z.object({
  name: z.string().min(1),
  import: z.string().min(1),
  manager: z.enum(['arduino', 'esp-idf', 'platformio', 'pip', 'other']).optional(),
  version: z.string().optional(),
  repository: z.string().optional(),
  purpose: z.string(),
  builtIn: z.boolean().optional(),
});

export const ComponentDefinitionSchema = z.object({
  id: z.string().min(2),
  name: z.string().min(1),
  category: z.enum([
    'microcontroller',
    'motor',
    'motor_driver',
    'sensor',
    'communication',
    'actuator',
    'display',
    'power',
    'passive',
    'discrete',
    'electromechanical',
    'input_device',
    'prototyping',
    'other',
  ]),
  description: z.string().min(1),
  voltage: z.number().optional(),
  minVoltage: z.number().optional(),
  maxVoltage: z.number().optional(),
  currentRequirements: z
    .object({ typicalMa: z.number().optional(), maxMa: z.number().optional(), note: z.string().optional() })
    .optional(),
  pins: z.array(ComponentPinSchema),
  pinTypes: z.array(z.string()),
  communicationProtocols: z.array(z.string()),
  powerPins: z.array(z.string()),
  groundPins: z.array(z.string()),
  compatibleMicrocontrollers: z.array(z.string()).optional(),
  incompatibleComponents: z.array(z.string()).optional(),
  motorRequirements: z
    .object({
      motorType: z.enum(['dc', 'servo', 'stepper']).optional(),
      channels: z.number().int().optional(),
      requiresDriver: z.boolean().optional(),
      requiresExternalSupply: z.boolean().optional(),
      supplyVoltageMin: z.number().optional(),
      supplyVoltageMax: z.number().optional(),
      maxCurrentPerChannelMa: z.number().optional(),
      stallCurrentMa: z.number().optional(),
      holdingTorqueKgCm: z.number().optional(),
      stepsPerRevolution: z.number().optional(),
      rpm: z.number().optional(),
      controlSignal: z.enum(['pwm', 'digital', 'analog', 'serial', 'step_dir']).optional(),
      logicVoltage: z.number().optional(),
    })
    .optional(),
  powerSourceRequirements: z
    .object({
      outputVoltage: z.number().optional(),
      outputVoltageMin: z.number().optional(),
      outputVoltageMax: z.number().optional(),
      capacityMah: z.number().optional(),
      maxCurrentMa: z.number().optional(),
      adjustable: z.boolean().optional(),
      chemistry: z.string().optional(),
      rail: z.string().optional(),
    })
    .optional(),
  libraryRequirements: z.array(LibraryRequirementSchema).optional(),
  exampleUsage: z.array(z.string()).optional(),
  aliases: z.array(z.string()),
  keywords: z.array(z.string()),
  simulator: z
    .object({
      part: z.string().optional(),
      attrs: z.record(z.string(), z.string()).optional(),
      supported: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ComponentDefinitionInput = z.infer<typeof ComponentDefinitionSchema>;
