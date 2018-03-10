# This code may look unusually verbose for Ruby (and it is), but
# it performs some subtle and complex validation of JSON data.
#
# To parse this JSON, add 'dry-struct' and 'dry-types' gems, then do:
#
#   top_level = TopLevel.from_json! "{…}"
#   puts top_level.nullable_map_value["…"].nil?
#
# If from_json! succeeds, the value returned matches the schema.

require 'json'
require 'dry-types'
require 'dry-struct'

module Types
  include Dry::Types.module
end

class DifferentThingClass < Dry::Struct
  attribute :name, Types::Strict::String

  def self.from_dynamic!(d)
    new(
      name: d["name"],
    )
  end

  def self.from_json!(json)
    from_dynamic!(JSON.parse(json))
  end

  def to_dynamic
    {
      "name" => @name,
    }
  end

  def to_json(options = nil)
    JSON.generate(to_dynamic, options)
  end
end

class DifferentThingElement < Dry::Struct
  attribute :different_thing_class, Types.Instance(DifferentThingClass).optional
  attribute :integer,               Types::Strict::Int.optional
  attribute :string,                Types::Strict::String.optional

  def self.from_dynamic!(d)
    union = new(
      different_thing_class:
        begin schema[:different_thing_class][DifferentThingClass.from_dynamic!(d)] rescue nil end,
      integer:
        begin schema[:integer][d] rescue nil end,
      string:
        begin schema[:string][d] rescue nil end,
    )
    raise "Invalid union" unless union.__attributes__.count { |k, v| not v.nil? } == 1
    union
  end

  def self.from_json!(json)
    from_dynamic!(JSON.parse(json))
  end

  def to_dynamic
    if @different_thing_class != nil
      then @different_thing_class.to_dynamic
    elsif @integer != nil
      then @integer
    elsif @string != nil
      then @string
      end
  end

  def to_json(options = nil)
    JSON.generate(to_dynamic, options)
  end
end

class PersonElement < Dry::Struct
  attribute :name,           Types::Strict::String
  attribute :int_or_string,  Types::Strict::Int | Types::Strict::String
  attribute :optional_value, Types::Strict::Bool.optional

  def self.from_dynamic!(d)
    new(
      name:           d["name"],
      int_or_string:  d["intOrString"],
      optional_value: d["optionalValue"],
    )
  end

  def self.from_json!(json)
    from_dynamic!(JSON.parse(json))
  end

  def to_dynamic
    {
      "name"          => @name,
      "intOrString"   => @int_or_string,
      "optionalValue" => @optional_value,
    }
  end

  def to_json(options = nil)
    JSON.generate(to_dynamic, options)
  end
end

class Person1 < Dry::Struct
  attribute :name,          Types::Strict::String
  attribute :int_or_string, Types::Strict::Int

  def self.from_dynamic!(d)
    new(
      name:          d["name"],
      int_or_string: d["intOrString"],
    )
  end

  def self.from_json!(json)
    from_dynamic!(JSON.parse(json))
  end

  def to_dynamic
    {
      "name"        => @name,
      "intOrString" => @int_or_string,
    }
  end

  def to_json(options = nil)
    JSON.generate(to_dynamic, options)
  end
end

class TopLevel < Dry::Struct
  attribute :string_value,       Types::Strict::String
  attribute :date_value,         Types::Strict::String
  attribute :uuid_value,         Types::Strict::String
  attribute :name_with_spaces,   Types::Nil
  attribute :double_value,       Types::Decimal
  attribute :int_value,          Types::Strict::Int
  attribute :boolean_value,      Types::Strict::Bool
  attribute :null_value,         Types::Nil
  attribute :tuples,             Types.Array(Types.Array(Types::Strict::Int | Types::Strict::String))
  attribute :person,             Types.Instance(Person1)
  attribute :people,             Types.Array(Types.Instance(PersonElement))
  attribute :different_things,   Types.Array(Types.Instance(DifferentThingElement))
  attribute :map_value,          Types::Strict::Hash.meta(of: Types::Strict::Int.optional)
  attribute :nullable_map_value, Types::Strict::Hash.meta(of: Types::Strict::Int.optional)

  def self.from_dynamic!(d)
    new(
      string_value:       d["stringValue"],
      date_value:         d["dateValue"],
      uuid_value:         d["uuidValue"],
      name_with_spaces:   d["name with spaces"],
      double_value:       d["doubleValue"],
      int_value:          d["intValue"],
      boolean_value:      d["booleanValue"],
      null_value:         d["nullValue"],
      tuples:             d["tuples"],
      person:             Person1.from_dynamic!(d["person"]),
      people:             d["people"].map { |x| PersonElement.from_dynamic!(x) },
      different_things:   d["differentThings"].map { |x| DifferentThingElement.from_dynamic!(x) },
      map_value:          d["mapValue"].map { |k, v| [k, v.nil? ? nil : v] }.to_hash,
      nullable_map_value: d["nullableMapValue"].map { |k, v| [k, v.nil? ? nil : v] }.to_hash,
    )
  end

  def self.from_json!(json)
    from_dynamic!(JSON.parse(json))
  end

  def to_dynamic
    {
      "stringValue"      => @string_value,
      "dateValue"        => @date_value,
      "uuidValue"        => @uuid_value,
      "name with spaces" => @name_with_spaces,
      "doubleValue"      => @double_value,
      "intValue"         => @int_value,
      "booleanValue"     => @boolean_value,
      "nullValue"        => @null_value,
      "tuples"           => @tuples,
      "person"           => @person.to_dynamic,
      "people"           => @people.map { |x| x.to_dynamic },
      "differentThings"  => @different_things.map { |x| raise 'implement union to_dynamic' },
      "mapValue"         => @map_value.map { |k, v| [k, v.nil? ? nil : v] }.to_hash,
      "nullableMapValue" => @nullable_map_value.map { |k, v| [k, v.nil? ? nil : v] }.to_hash,
    }
  end

  def to_json(options = nil)
    JSON.generate(to_dynamic, options)
  end
end
